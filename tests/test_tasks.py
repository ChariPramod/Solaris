from dataclasses import asdict, replace

import pytest
import yaml

from gauntlet.models import load_tasks, validate_task


def test_all_twelve_task_ids_are_implemented():
    assert [task.id for task in load_tasks()] == [f"T{number:02}" for number in range(1, 13)]


@pytest.mark.parametrize(
    "updates",
    [
        {"id": "../../escape"},
        {"tier": True},
        {"max_steps": 0},
        {"max_seconds": "300"},
        {"prompt": None},
        {"tags": "editor"},
        {"setup": {"formsite": "yes"}},
        {"setup": {"unknown": True}},
        {"setup": {"injection": True}},
        {"verifier": {"kind": "unknown"}},
        {"verifier": {"kind": "text", "path": "../note.txt", "expected": "hello"}},
        {"verifier": {"kind": "text", "path": "/tmp/note.txt", "expected": "hello"}},
        {"verifier": {"kind": "text", "path": "docs/note.txt", "expected": "hello"}},
        {"verifier": {"kind": "text", "path": "out/../note.txt", "expected": "hello"}},
        {"verifier": {"kind": "text", "path": "out/note.txt", "expected": "hello", "typo": 1}},
        {"allowed_changes": {"contacts.txt": "stolen.txt"}},
        {"verifier": {"kind": "ods_cell", "path": "out/a.ods", "cell": "B0", "expected": "1"}},
        {"verifier": {"kind": "ods_cell", "path": "out/a.ods", "cell": "B12", "expected": "NaN"}},
    ],
)
def test_invalid_definitions_rejected(updates):
    with pytest.raises(ValueError):
        validate_task(replace(load_tasks("T02")[0], **updates))


@pytest.mark.parametrize("content", ["[not, a, task]", "prompt: [unclosed", "{}", "null"])
def test_yaml_error_identifies_source(content, tmp_path):
    (tmp_path / "bad.yaml").write_text(content)
    with pytest.raises(ValueError, match="Invalid task bad.yaml"):
        load_tasks(directory=tmp_path)


def test_duplicate_ids_are_rejected(tmp_path):
    task = asdict(load_tasks("T02")[0])
    for name in ("a", "b"):
        (tmp_path / f"{name}.yaml").write_text(yaml.safe_dump(task))
    with pytest.raises(ValueError, match="Duplicate task ids"):
        load_tasks(directory=tmp_path)


def test_selection_accepts_spaces_and_case():
    assert [t.id for t in load_tasks(" t02, T01 ")] == ["T01", "T02"]


def test_fingerprint_changes_with_task_semantics_not_mapping_order():
    task = load_tasks("T02")[0]
    assert (
        task.fingerprint
        == replace(task, verifier=dict(reversed(task.verifier.items()))).fingerprint
    )
    assert task.fingerprint != replace(task, max_steps=11).fingerprint
    assert task.fingerprint != replace(task, prompt="A different task").fingerprint
