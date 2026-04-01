from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from html import unescape
from typing import Any, Callable, Dict, Mapping, Optional
from urllib.parse import urljoin, urlparse

WORKER_VERSION = "0.1.0"
VALID_MODES = {"static", "dynamic", "stealth"}
VALID_OUTPUTS = {"text", "html", "markdown"}


class RequestValidationError(ValueError):
    """Raised when the inbound request does not match the worker contract."""


@dataclass(frozen=True)
class ExtractRequest:
    url: str
    mode: str = "static"
    selector: Optional[str] = None
    output: str = "text"
    timeout_ms: int = 30000
    wait_for: Optional[str] = None
    include_links: bool = False


def normalize_extract_request(payload: Mapping[str, Any]) -> ExtractRequest:
    if not isinstance(payload, Mapping):
        raise RequestValidationError("Request body must be a JSON object")

    raw_url = str(payload.get("url", "")).strip()
    parsed_url = urlparse(raw_url)
    if not raw_url or parsed_url.scheme not in {"http", "https"} or not parsed_url.netloc:
        raise RequestValidationError("Field 'url' must be a valid http/https URL")

    mode = str(payload.get("mode", "static")).strip().lower()
    if mode not in VALID_MODES:
        raise RequestValidationError(f"Unsupported mode: {mode}")

    output = str(payload.get("output", "text")).strip().lower()
    if output not in VALID_OUTPUTS:
        raise RequestValidationError(f"Unsupported output: {output}")

    selector = payload.get("selector")
    wait_for = payload.get("wait_for")
    timeout_ms = normalize_timeout_ms(payload.get("timeout_ms"))

    return ExtractRequest(
        url=raw_url,
        mode=mode,
        selector=str(selector).strip() or None if selector is not None else None,
        output=output,
        timeout_ms=timeout_ms,
        wait_for=str(wait_for).strip() or None if wait_for is not None else None,
        include_links=payload.get("include_links") is True,
    )


def normalize_timeout_ms(raw_value: Any) -> int:
    if isinstance(raw_value, bool):
        return 30000
    if isinstance(raw_value, int):
        return raw_value if raw_value > 0 else 30000
    if isinstance(raw_value, str) and raw_value.strip().isdigit():
        parsed = int(raw_value.strip())
        return parsed if parsed > 0 else 30000
    return 30000


def build_fetch_kwargs(request: ExtractRequest) -> Dict[str, Any]:
    if request.mode == "static":
        timeout_seconds = max(1, int((request.timeout_ms + 999) / 1000))
        kwargs: Dict[str, Any] = {"timeout": timeout_seconds}
        try:
            import certifi

            kwargs["verify"] = certifi.where()
        except ImportError:
            pass

        return kwargs

    kwargs: Dict[str, Any] = {"timeout": request.timeout_ms}
    if request.wait_for == "network_idle":
        kwargs["network_idle"] = True
    elif request.wait_for:
        kwargs["wait_selector"] = request.wait_for
        kwargs["wait_selector_state"] = "visible"

    return kwargs


def load_fetchers() -> Dict[str, Any]:
    try:
        from scrapling.fetchers import DynamicFetcher, Fetcher, StealthyFetcher
    except ImportError as exc:
        raise RuntimeError(
            "Scrapling is not installed. Run `pip install -r workers/scrapling_worker/requirements.txt`."
        ) from exc

    return {
        "static": Fetcher(),
        "dynamic": DynamicFetcher(),
        "stealth": StealthyFetcher(),
    }


def select_fetch_method(fetcher: Any, mode: str) -> Callable[..., Any]:
    preferred_name = "get" if mode == "static" else "fetch"
    preferred = getattr(fetcher, preferred_name, None)
    if callable(preferred):
        return preferred

    fallback = getattr(fetcher, "fetch", None) or getattr(fetcher, "get", None)
    if callable(fallback):
        return fallback

    raise RuntimeError(f"Fetcher for mode '{mode}' does not expose a supported request method")


def extract_document(
    request: ExtractRequest | Mapping[str, Any],
    *,
    fetchers: Optional[Mapping[str, Any]] = None,
    markdown_converter: Optional[Callable[[str], str]] = None,
) -> Dict[str, Any]:
    normalized = (
        request if isinstance(request, ExtractRequest) else normalize_extract_request(request)
    )
    fetcher_map = dict(fetchers or {})

    if normalized.mode == "static" and fetcher_map.get("static") is None:
        page = fetch_static_page(normalized)
    else:
        if not fetcher_map:
            fetcher_map = load_fetchers()
        fetcher = fetcher_map.get(normalized.mode)
        if fetcher is None:
            raise RuntimeError(f"Fetcher for mode '{normalized.mode}' is not configured")

        fetch_method = select_fetch_method(fetcher, normalized.mode)
        page = fetch_method(normalized.url, **build_fetch_kwargs(normalized))
    final_url = getattr(page, "url", normalized.url)
    status = getattr(page, "status", None)
    title = coerce_scalar(getattr(page, "css_first", lambda _selector: None)("title::text"))

    target = page
    selector_found = True
    if normalized.selector:
        target = getattr(page, "css_first", lambda _selector: None)(normalized.selector)
        selector_found = target is not None

    if not selector_found:
        return {
            "ok": False,
            "url": normalized.url,
            "final_url": final_url,
            "status": status,
            "title": title,
            "content": None,
            "text": None,
            "html": None,
            "markdown": None,
            "links": [],
            "metadata": build_metadata(normalized, status, selector_found),
            "error_message": f"Selector '{normalized.selector}' matched no elements",
        }

    html = extract_html(page, target, normalized.selector)
    text = extract_text(target)
    markdown = None
    if html is not None:
        markdown = render_markdown(html, markdown_converter=markdown_converter)
    elif text is not None:
        markdown = text

    links = extract_links(target if normalized.selector else page, final_url) if normalized.include_links else []
    content = {
        "text": text,
        "html": html,
        "markdown": markdown,
    }[normalized.output]

    ok = True if status is None else int(status) < 400

    return {
        "ok": ok,
        "url": normalized.url,
        "final_url": final_url,
        "status": status,
        "title": title,
        "content": content,
        "text": text,
        "html": html,
        "markdown": markdown,
        "links": links,
        "metadata": build_metadata(normalized, status, selector_found),
        "error_message": None if ok else f"Upstream page returned status {status}",
    }


def build_metadata(request: ExtractRequest, status: Optional[int], selector_found: bool) -> Dict[str, Any]:
    return {
        "mode": request.mode,
        "output": request.output,
        "selector": request.selector,
        "selector_found": selector_found,
        "wait_for": request.wait_for,
        "include_links": request.include_links,
        "timeout_ms": request.timeout_ms,
        "status": status,
    }


def fetch_static_page(request: ExtractRequest) -> "SoupPage":
    try:
        import certifi
    except ImportError as exc:
        raise RuntimeError("certifi is required for static extraction") from exc

    try:
        import requests
    except ImportError as exc:
        raise RuntimeError("requests is required for static extraction") from exc

    session = requests.Session()
    session.trust_env = False
    request_kwargs = {
        "timeout": max(1, int((request.timeout_ms + 999) / 1000)),
        "allow_redirects": True,
        "headers": {"User-Agent": "newagent-scrapling-worker/0.1"},
    }

    try:
        response = session.get(
            request.url,
            verify=certifi.where(),
            **request_kwargs,
        )
    except requests.exceptions.SSLError:
        import urllib3

        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
        response = session.get(
            request.url,
            verify=False,
            **request_kwargs,
        )
    response.raise_for_status()
    return SoupPage(response.url, response.status_code, response.text)


def extract_text(target: Any) -> Optional[str]:
    if target is None:
        return None

    text = getattr(target, "text", None)
    if text is not None:
        return coerce_scalar(text)

    get_all_text = getattr(target, "get_all_text", None)
    if callable(get_all_text):
        return coerce_scalar(get_all_text(strip=True))

    return coerce_scalar(target)


def extract_html(page: Any, target: Any, selector: Optional[str]) -> Optional[str]:
    if target is None:
        return None

    if selector:
        html_content = getattr(target, "html_content", None)
        if html_content is not None:
            return coerce_scalar(html_content)

    body = getattr(page, "body", None)
    if body is not None and selector is None:
        if isinstance(body, bytes):
            return body.decode("utf-8", errors="replace")
        return str(body)

    html_content = getattr(target, "html_content", None)
    if html_content is not None:
        return coerce_scalar(html_content)

    return None


def render_markdown(
    html: str,
    *,
    markdown_converter: Optional[Callable[[str], str]] = None,
) -> str:
    if markdown_converter is not None:
        return markdown_converter(html)

    try:
        from markdownify import markdownify
    except ImportError:
        return strip_tags(html)

    return markdownify(html, heading_style="ATX").strip()


def strip_tags(value: str) -> str:
    in_tag = False
    chunks = []
    for char in value:
        if char == "<":
            in_tag = True
            continue
        if char == ">":
            in_tag = False
            continue
        if not in_tag:
            chunks.append(char)
    return " ".join(unescape("".join(chunks)).split())


def extract_links(container: Any, base_url: str) -> list[str]:
    css = getattr(container, "css", None)
    if not callable(css):
        return []

    raw_selection = css("a::attr(href)")
    raw_links = []
    if hasattr(raw_selection, "get_all") and callable(raw_selection.get_all):
        raw_links = raw_selection.get_all()
    elif hasattr(raw_selection, "getall") and callable(raw_selection.getall):
        raw_links = raw_selection.getall()
    elif isinstance(raw_selection, (list, tuple)):
        raw_links = list(raw_selection)

    normalized = []
    seen = set()
    for item in raw_links:
        href = coerce_scalar(item)
        if not href:
            continue
        absolute = urljoin(base_url, href)
        if absolute in seen:
            continue
        seen.add(absolute)
        normalized.append(absolute)

    return normalized


def coerce_scalar(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    return str(value).strip() or None


class LinkSelection:
    def __init__(self, values: list[str]):
        self._values = values

    def get_all(self) -> list[str]:
        return list(self._values)


class SoupNode:
    def __init__(self, element):
        self._element = element

    @property
    def text(self) -> str:
        return self._element.get_text(" ", strip=True)

    @property
    def html_content(self) -> str:
        return str(self._element)

    def get_all_text(self, strip: bool = False) -> str:
        text = self._element.get_text(" ", strip=strip)
        return " ".join(text.split()) if strip else text

    def css(self, selector: str):
        return select_from_soup(self._element, selector)


class SoupPage:
    def __init__(self, url: str, status: int, html: str):
        from bs4 import BeautifulSoup

        self.url = url
        self.status = status
        self.body = html
        self._soup = BeautifulSoup(html, "html.parser")

    @property
    def text(self) -> str:
        return self.get_all_text(strip=True)

    @property
    def html_content(self) -> str:
        return self.body

    def get_all_text(self, strip: bool = False) -> str:
        text = self._soup.get_text(" ", strip=strip)
        return " ".join(text.split()) if strip else text

    def css_first(self, selector: str):
        selected = select_from_soup(self._soup, selector, first=True)
        if isinstance(selected, list):
            return selected[0] if selected else None
        return selected

    def css(self, selector: str):
        return select_from_soup(self._soup, selector)


def select_from_soup(container, selector: str, *, first: bool = False):
    selector = selector.strip()
    if selector.endswith("::text"):
        base_selector = selector[: -len("::text")] or "*"
        node = container.select_one(base_selector)
        if node is None:
            return None if first else []
        text = node.get_text(" ", strip=True)
        return text if first else [text]

    if "::attr(" in selector and selector.endswith(")"):
        base_selector, attribute = selector.split("::attr(", 1)
        attr_name = attribute[:-1]
        nodes = container.select(base_selector or "*")
        values = [node.get(attr_name) for node in nodes if node.get(attr_name)]
        if first:
            return values[0] if values else None
        return LinkSelection(values)

    if first:
        node = container.select_one(selector)
        return SoupNode(node) if node is not None else None

    nodes = [SoupNode(node) for node in container.select(selector)]
    return nodes


class ScraplingWorkerServer(ThreadingHTTPServer):
    def __init__(
        self,
        server_address: tuple[str, int],
        handler_class,
        *,
        extractor: Optional[Callable[[ExtractRequest], Dict[str, Any]]] = None,
    ):
        super().__init__(server_address, handler_class)
        self.extractor = extractor or (lambda request: extract_document(request))


def create_server(
    host: str,
    port: int,
    *,
    extractor: Optional[Callable[[ExtractRequest], Dict[str, Any]]] = None,
) -> ScraplingWorkerServer:
    return ScraplingWorkerServer((host, port), ScraplingWorkerHandler, extractor=extractor)


def dispatch_request(
    method: str,
    path: str,
    body: Optional[bytes],
    *,
    extractor: Optional[Callable[[ExtractRequest], Dict[str, Any]]] = None,
) -> tuple[int, Dict[str, Any]]:
    runner = extractor or (lambda request: extract_document(request))

    if method == "GET":
        if path != "/healthz":
            return 404, {"ok": False, "error_message": "Not found"}

        return 200, {
            "ok": True,
            "service": "newagent-scrapling-worker",
            "version": WORKER_VERSION,
            "modes": sorted(VALID_MODES),
            "outputs": sorted(VALID_OUTPUTS),
        }

    if method == "POST":
        if path != "/v1/extract":
            return 404, {"ok": False, "error_message": "Not found"}

        try:
            payload = json.loads((body or b"{}").decode("utf-8"))
            request = normalize_extract_request(payload)
            return 200, runner(request)
        except RequestValidationError as exc:
            return 400, {"ok": False, "error_message": str(exc)}
        except json.JSONDecodeError:
            return 400, {"ok": False, "error_message": "Request body must be valid JSON"}
        except Exception as exc:  # pragma: no cover - defensive edge
            return 500, {"ok": False, "error_message": str(exc)}

    return 405, {"ok": False, "error_message": f"Unsupported method: {method}"}


class ScraplingWorkerHandler(BaseHTTPRequestHandler):
    server_version = f"NewagentScraplingWorker/{WORKER_VERSION}"

    def do_GET(self) -> None:  # noqa: N802
        status_code, payload = dispatch_request(
            "GET",
            self.path,
            None,
            extractor=self.server.extractor,
        )
        self.write_json(status_code, payload)

    def do_POST(self) -> None:  # noqa: N802
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0

        raw_body = self.rfile.read(content_length) if content_length > 0 else b"{}"
        status_code, payload = dispatch_request(
            "POST",
            self.path,
            raw_body,
            extractor=self.server.extractor,
        )
        self.write_json(status_code, payload)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        return

    def write_json(self, status_code: int, payload: Mapping[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the newagent Scrapling worker")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7771)
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    args = build_arg_parser().parse_args(argv)
    server = create_server(args.host, args.port)

    try:
        print(
            json.dumps(
                {
                    "ok": True,
                    "service": "newagent-scrapling-worker",
                    "host": args.host,
                    "port": args.port,
                    "version": WORKER_VERSION,
                },
                ensure_ascii=False,
            )
        )
        server.serve_forever()
    except KeyboardInterrupt:
        return 0
    finally:
        server.server_close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
