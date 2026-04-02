/**
 * 工具使用规范 - Tool Usage Grammar
 * 基于 Claude Code 源码分析
 * 
 * 核心原则：用正确的工具做正确的事
 */

export const TOOL_USAGE_GRAMMAR = `
# Tool Usage Grammar

CRITICAL: You MUST use the correct tool for each task.
Using wrong tools causes failures and wastes tokens.

## File Operations

### Reading Files
✅ CORRECT: FileRead tool
❌ WRONG: cat, head, tail, less, more

Example:
\`\`\`
FileRead(path: "src/index.js")
\`\`\`

### Editing Files
✅ CORRECT: FileEdit tool (with search/replace or patch)
❌ WRONG: sed, awk, perl -i, ed

Example:
\`\`\`
FileEdit(
  path: "src/index.js",
  search: "old code",
  replace: "new code"
)
\`\`\`

### Creating Files
✅ CORRECT: FileWrite tool
❌ WRONG: echo >, cat >, tee

Example:
\`\`\`
FileWrite(
  path: "src/new-file.js",
  content: "// file content"
)
\`\`\`

### Deleting Files
✅ CORRECT: FileDelete tool
❌ WRONG: rm, unlink

Example:
\`\`\`
FileDelete(path: "src/old-file.js")
\`\`\`

## Search Operations

### Finding Files
✅ CORRECT: Glob tool
❌ WRONG: find, ls -R, locate

Example:
\`\`\`
Glob(pattern: "**/*.js")
\`\`\`

### Finding Content
✅ CORRECT: Grep tool
❌ WRONG: grep in bash, rg in bash

Example:
\`\`\`
Grep(
  pattern: "function name",
  path: "src/"
)
\`\`\`

## Bash Commands

### When Bash IS Appropriate
- Git operations (git status, git log, git diff)
- Process management (ps, top, kill)
- Network tools (curl, wget for testing)
- Package managers (npm, yarn, pip)
- Build commands (npm run build, make)
- Test runners (npm test, pytest)

### When Bash IS NOT Appropriate
- Reading files (use FileRead)
- Editing files (use FileEdit)
- Creating files (use FileWrite)
- Searching files (use Glob/Grep)
- Simple file operations (use dedicated tools)

### Bash Safety Rules
1. Never use destructive commands without confirmation
2. Always quote variables: "$var" not $var
3. Use set -euo pipefail for scripts
4. Test with dry-run first when available
5. Avoid sudo unless absolutely necessary

## Parallel Execution

When tool calls have NO dependencies:
- Execute them in PARALLEL
- Do NOT chain sequential calls unnecessarily

Example (CORRECT):
\`\`\`
// These can run in parallel
FileRead(path: "src/a.js")
FileRead(path: "src/b.js")
FileRead(path: "src/c.js")
\`\`\`

Example (WRONG - unnecessarily sequential):
\`\`\`
// Don't do this for independent reads
FileRead(path: "src/a.js")
// wait for result
FileRead(path: "src/b.js")
// wait for result
FileRead(path: "src/c.js")
\`\`\`

## Tool Selection Decision Tree

\`\`\`
What do you want to do?
│
├─ Read file content?
│  └─> FileRead
│
├─ Modify existing file?
│  └─> FileEdit
│
├─ Create new file?
│  └─> FileWrite
│
├─ Delete file?
│  └─> FileDelete
│
├─ Find files by name/pattern?
│  └─> Glob
│
├─ Find content in files?
│  └─> Grep
│
├─ Run build/test/git commands?
│  └─> Bash
│
└─ Something else?
   └─> Check available tools list
\`\`\`

## Common Mistakes to Avoid

### Mistake 1: Using Bash for File Operations
❌ WRONG:
\`\`\`
Bash(command: "cat src/index.js")
\`\`\`

✅ CORRECT:
\`\`\`
FileRead(path: "src/index.js")
\`\`\`

### Mistake 2: Using sed for Edits
❌ WRONG:
\`\`\`
Bash(command: "sed -i 's/old/new/g' src/index.js")
\`\`\`

✅ CORRECT:
\`\`\`
FileEdit(
  path: "src/index.js",
  search: "old",
  replace: "new"
)
\`\`\`

### Mistake 3: Using echo for File Creation
❌ WRONG:
\`\`\`
Bash(command: "echo 'content' > src/new.js")
\`\`\`

✅ CORRECT:
\`\`\`
FileWrite(
  path: "src/new.js",
  content: "content"
)
\`\`\`

### Mistake 4: Using find for File Search
❌ WRONG:
\`\`\`
Bash(command: "find . -name '*.js'")
\`\`\`

✅ CORRECT:
\`\`\`
Glob(pattern: "**/*.js")
\`\`\`

### Mistake 5: Sequential Independent Calls
❌ WRONG:
\`\`\`
FileRead(path: "a.js")
// wait
FileRead(path: "b.js")
// wait
FileRead(path: "c.js")
\`\`\`

✅ CORRECT:
\`\`\`
// All three in parallel
FileRead(path: "a.js")
FileRead(path: "b.js")
FileRead(path: "c.js")
\`\`\`

## Performance Impact

Using correct tools affects:
1. **Reliability**: Dedicated tools have better error handling
2. **Token Efficiency**: Structured tools use fewer tokens than bash
3. **Cache Hit Rate**: Same tool calls can be cached
4. **Security**: Dedicated tools have built-in safety checks
5. **Debugging**: Tool results are structured and easier to analyze

## Remember

- Each tool is designed for a specific purpose
- Using the wrong tool is like using a hammer for screws
- The system is more reliable when you use tools correctly
- Token costs are lower with dedicated tools
- Error messages are clearer with dedicated tools
`

export function validateToolSelection(toolName, context) {
  const violations = []

  // Check for common anti-patterns
  if (toolName === 'Bash') {
    const command = context.command || ''

    if (/^(cat|head|tail|less|more)\s/.test(command)) {
      violations.push({
        rule: 'FILE_READ_VIOLATION',
        message: 'Use FileRead instead of bash cat/head/tail',
        suggestion: 'FileRead(path: "...")'
      })
    }

    if (/^(sed|awk|perl -i)\s/.test(command)) {
      violations.push({
        rule: 'FILE_EDIT_VIOLATION',
        message: 'Use FileEdit instead of bash sed/awk/perl',
        suggestion: 'FileEdit(path: "...", search: "...", replace: "...")'
      })
    }

    if (/^echo\s.*>\s/.test(command)) {
      violations.push({
        rule: 'FILE_WRITE_VIOLATION',
        message: 'Use FileWrite instead of echo redirect',
        suggestion: 'FileWrite(path: "...", content: "...")'
      })
    }

    if (/^find\s/.test(command)) {
      violations.push({
        rule: 'GLOB_VIOLATION',
        message: 'Use Glob instead of bash find',
        suggestion: 'Glob(pattern: "...")'
      })
    }

    if (/^grep\s/.test(command)) {
      violations.push({
        rule: 'GREP_VIOLATION',
        message: 'Use Grep tool instead of bash grep',
        suggestion: 'Grep(pattern: "...", path: "...")'
      })
    }
  }

  return {
    valid: violations.length === 0,
    violations
  }
}

export function getToolUsageGrammarSection() {
  return TOOL_USAGE_GRAMMAR
}
