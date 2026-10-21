> DSH adapter boundary: resolve this resource from the loaded skill's directory resourceBase. Examples are not authority: installation/download/login, private state, Git writes and destructive operations need exact explicit authorization. Use only tools and native roles actually exposed in the current catalog and allowed by the caller; otherwise use a real direct fallback or report the limitation. Translate shell examples to the active runtime.

# Code Quality Reviewer Prompt Template

Use this template only when an implemented change benefits from focused code-quality or maintainability review.

**Purpose:** Evaluate whether the current implementation is sound, maintainable, and appropriately verified.

```
Assignment content (not a tool-call schema; send through a permitted callable native role tool):
  Use template at requesting-code-review/code-reviewer.md

  Supply, without a required field order:
  - goal and acceptance criteria;
  - current diff or committed range, including new files;
  - relevant verification evidence;
  - global constraints;
  - focused dependency, interface, or maintainability context when material.
```

The reviewer does the review directly and does not dispatch subagents or second-opinion reviewers. Evaluate the change's contribution rather than penalizing unrelated pre-existing structure. Check boundaries, interfaces, local conventions, unnecessary complexity, error behavior, and whether the supplied evidence supports the relevant claims.

Report concrete findings with severity, location, impact, and supporting evidence. No fixed first-line verdict, field order, or receipt is required. Rerun only when substantive review input changes.
