from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import app  # noqa: E402


class FakeLinkSelection:
    def __init__(self, values):
        self._values = list(values)

    def get_all(self):
        return list(self._values)


class FakeNode:
    def __init__(self, *, text="node text", html="<div>node text</div>", links=None):
        self.text = text
        self.html_content = html
        self._links = list(links or [])

    def get_all_text(self, strip=False):
        return self.text.strip() if strip else self.text

    def css(self, selector):
        if selector == "a::attr(href)":
            return FakeLinkSelection(self._links)
        return FakeLinkSelection([])


class FakePage(FakeNode):
    def __init__(
        self,
        *,
        url="https://example.com/final",
        status=200,
        body="<html><head><title>Example Title</title></head><body>Hello</body></html>",
        title="Example Title",
        selector_node=None,
        links=None,
    ):
        super().__init__(text="page text", html=body, links=links)
        self.url = url
        self.status = status
        self.body = body
        self._title = title
        self._selector_node = selector_node

    def css_first(self, selector):
        if selector == "title::text":
            return self._title
        if selector == "#main":
            return self._selector_node
        return None


class RecorderFetcher:
    def __init__(self):
        self.calls = []
        self.page = FakePage()

    def get(self, url, **kwargs):
        self.calls.append(("get", url, kwargs))
        return self.page

    def fetch(self, url, **kwargs):
        self.calls.append(("fetch", url, kwargs))
        return self.page


class ScraplingWorkerTests(unittest.TestCase):
    def test_normalize_extract_request_applies_defaults(self):
        request = app.normalize_extract_request({"url": "https://example.com"})

        self.assertEqual(request.url, "https://example.com")
        self.assertEqual(request.mode, "static")
        self.assertEqual(request.output, "text")
        self.assertEqual(request.timeout_ms, 30000)
        self.assertIsNone(request.selector)
        self.assertFalse(request.include_links)

    def test_build_fetch_kwargs_maps_static_and_dynamic_waiting(self):
        static_request = app.normalize_extract_request(
            {"url": "https://example.com", "timeout_ms": 4500}
        )
        dynamic_request = app.normalize_extract_request(
            {
                "url": "https://example.com",
                "mode": "dynamic",
                "timeout_ms": 4500,
                "wait_for": "network_idle",
            }
        )
        selector_wait_request = app.normalize_extract_request(
            {
                "url": "https://example.com",
                "mode": "stealth",
                "wait_for": ".ready",
            }
        )

        static_kwargs = app.build_fetch_kwargs(static_request)
        self.assertEqual(static_kwargs["timeout"], 5)
        if "verify" in static_kwargs:
            self.assertTrue(str(static_kwargs["verify"]).endswith("cacert.pem"))
        self.assertEqual(
            app.build_fetch_kwargs(dynamic_request),
            {"timeout": 4500, "network_idle": True},
        )
        self.assertEqual(
            app.build_fetch_kwargs(selector_wait_request),
            {"timeout": 30000, "wait_selector": ".ready", "wait_selector_state": "visible"},
        )

    def test_extract_document_returns_requested_markdown_and_links(self):
        node = FakeNode(
            text="Main content",
            html="<main><a href=\"/docs\">Docs</a>Main content</main>",
            links=["/docs", "https://example.com/next"],
        )
        page = FakePage(selector_node=node)
        fetcher = RecorderFetcher()
        fetcher.page = page
        request = app.normalize_extract_request(
            {
                "url": "https://example.com/start",
                "mode": "dynamic",
                "selector": "#main",
                "output": "markdown",
                "include_links": True,
            }
        )

        result = app.extract_document(
            request,
            fetchers={
                "static": fetcher,
                "dynamic": fetcher,
                "stealth": fetcher,
            },
            markdown_converter=lambda html: f"MD::{html}",
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["final_url"], "https://example.com/final")
        self.assertEqual(result["title"], "Example Title")
        self.assertEqual(result["content"], "MD::<main><a href=\"/docs\">Docs</a>Main content</main>")
        self.assertEqual(result["text"], "Main content")
        self.assertEqual(
            result["links"],
            ["https://example.com/docs", "https://example.com/next"],
        )
        self.assertEqual(result["metadata"]["selector_found"], True)
        self.assertEqual(fetcher.calls[0][0], "fetch")
        self.assertEqual(fetcher.calls[0][2]["timeout"], 30000)

    def test_extract_document_reports_missing_selector(self):
        fetcher = RecorderFetcher()
        request = app.normalize_extract_request(
            {
                "url": "https://example.com/start",
                "selector": "#main",
            }
        )

        result = app.extract_document(
            request,
            fetchers={
                "static": fetcher,
                "dynamic": fetcher,
                "stealth": fetcher,
            },
        )

        self.assertFalse(result["ok"])
        self.assertIn("matched no elements", result["error_message"])
        self.assertEqual(result["metadata"]["selector_found"], False)

    def test_dispatch_request_serves_health_and_extract(self):
        def extractor(request):
            return {
                "ok": True,
                "url": request.url,
                "final_url": request.url,
                "title": None,
                "content": "ok",
                "text": "ok",
                "html": "<p>ok</p>",
                "markdown": "ok",
                "links": [],
                "metadata": {"mode": request.mode},
                "error_message": None,
            }

        health_status, health = app.dispatch_request("GET", "/healthz", None, extractor=extractor)
        extract_status, payload = app.dispatch_request(
            "POST",
            "/v1/extract",
            b'{"url":"https://example.com","mode":"dynamic"}',
            extractor=extractor,
        )

        self.assertEqual(health_status, 200)
        self.assertTrue(health["ok"])
        self.assertIn("dynamic", health["modes"])

        self.assertEqual(extract_status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["metadata"]["mode"], "dynamic")
        self.assertEqual(payload["final_url"], "https://example.com")


if __name__ == "__main__":
    unittest.main()
