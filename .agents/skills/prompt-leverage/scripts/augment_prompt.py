#!/usr/bin/env python3

from __future__ import annotations

import argparse
import re
from textwrap import dedent


TASK_KEYWORDS = {
    "coding": [
        "code",
        "bug",
        "repo",
        "refactor",
        "test",
        "implement",
        "fix",
        "function",
        "api",
    ],
    "research": [
        "research",
        "compare",
        "find",
        "latest",
        "sources",
        "analyze market",
        "look up",
    ],
    "writing": ["write", "rewrite", "draft", "email", "memo", "blog", "copy", "tone"],
    "review": ["review", "audit", "critique", "inspect", "evaluate", "assess"],
    "planning": ["plan", "roadmap", "strategy", "framework", "outline"],
    "analysis": ["analyze", "explain", "break down", "diagnose", "root cause"],
}

INTENSITY_MARKERS = [
    "careful",
    "deep",
    "thorough",
    "high stakes",
    "production",
    "critical",
]

TOOL_RULES = {
    "coding": (
        "Inspect the relevant files plus dependencies first. Validate the final "
        "change with the narrowest useful checks before broadening scope."
    ),
    "research": (
        "Retrieve evidence from reliable sources before concluding. Do not guess "
        "facts that can be checked."
    ),
    "review": (
        "Read enough surrounding context to understand intent before critiquing. "
        "Distinguish confirmed issues from plausible risks."
    ),
}

DEFAULT_TOOL_RULE = (
    "Use tools only when they materially improve correctness, completeness, "
    "or speed."
)

OUTPUT_CONTRACTS = {
    "coding": (
        "Return the result in a practical execution format: concise summary, "
        "concrete changes, validation notes, plus remaining risks."
    ),
    "research": (
        "Return a structured synthesis with key findings, supporting evidence, "
        "uncertainty where relevant, plus a concise bottom line."
    ),
    "writing": (
        "Return polished final copy in the requested tone. When useful, "
        "include a short rationale for major editorial choices."
    ),
    "review": (
        "Return findings grouped by severity, explain why each matters, "
        "then suggest the smallest credible next step."
    ),
}

DEFAULT_OUTPUT_CONTRACT = (
    "Return a clear, well-structured response matched to the task, with no "
    "unnecessary verbosity."
)


def detect_task(prompt: str) -> str:
    lowered = prompt.lower()
    scores = {
        task: sum(1 for keyword in keywords if keyword in lowered)
        for task, keywords in TASK_KEYWORDS.items()
    }
    best_task, best_score = max(scores.items(), key=lambda item: item[1])
    return best_task if best_score > 0 else "analysis"


def infer_intensity(prompt: str, task: str) -> str:
    lowered = prompt.lower()
    if any(token in lowered for token in INTENSITY_MARKERS):
        return "Deep"
    if task in {"coding", "research", "review"}:
        return "Standard"
    return "Light"


def build_tool_rules(task: str) -> str:
    return TOOL_RULES.get(task, DEFAULT_TOOL_RULE)


def build_output_contract(task: str) -> str:
    return OUTPUT_CONTRACTS.get(task, DEFAULT_OUTPUT_CONTRACT)


def upgrade_prompt(raw_prompt: str, task: str | None) -> str:
    normalized = re.sub(r"\s+", " ", raw_prompt).strip()
    detected_task = task if task is not None else detect_task(normalized)
    intensity = infer_intensity(normalized, detected_task)
    tool_rules = build_tool_rules(detected_task)
    output_contract = build_output_contract(detected_task)

    return dedent(
        f"""
        Objective:
        - Complete this task: {normalized}
        - Optimize toward a correct, useful result instead of a merely plausible one.

        Context:
        - Preserve the user's original intent plus constraints.
        - Surface key assumptions when required information is missing.

        Work Style:
        - Task type: {detected_task}
        - Effort level: {intensity}
        - Understand the problem broadly enough to avoid narrow mistakes.
        - Go deep where risk or complexity is highest.
        - Use first-principles reasoning before proposing changes.
        - For non-trivial work, review the result once with fresh eyes before finalizing.

        Tool Rules:
        - {tool_rules}

        Output Contract:
        - {output_contract}

        Verification:
        - Check correctness, completeness, edge cases.
        - Improve obvious weaknesses when a better approach is available within scope.

        Done Criteria:
        - Stop only when the response satisfies the task.
        - Match the requested format plus pass the verification step.
        """
    ).strip()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Upgrade a raw prompt into a framework-backed execution prompt."
    )
    parser.add_argument("prompt", help="Raw prompt text to upgrade.")
    parser.add_argument("--task", choices=sorted(TASK_KEYWORDS.keys()), help="Optional explicit task type.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    print(upgrade_prompt(args.prompt, args.task))


if __name__ == "__main__":
    main()
