import importlib.util
from pathlib import Path


def load_augment_prompt():
    script_path = Path(__file__).resolve().parent / "augment_prompt.py"
    spec = importlib.util.spec_from_file_location("augment_prompt", script_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_detect_task_prefers_coding_keywords():
    augment_prompt = load_augment_prompt()

    task = augment_prompt.detect_task("Fix the repo bug and add a regression test.")

    assert task == "coding"


def test_upgrade_prompt_preserves_constraints_and_contract():
    augment_prompt = load_augment_prompt()

    upgraded = augment_prompt.upgrade_prompt(
        "Carefully research the latest docs and cite sources.",
        task=None,
    )

    assert "Task type: research" in upgraded
    assert "Effort level: Deep" in upgraded
    assert "Carefully research the latest docs and cite sources." in upgraded
    assert "Do not guess facts that can be checked." in upgraded
