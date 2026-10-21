"""Regression tests for strict ast-grep binary resolution."""

from __future__ import annotations

import importlib.util
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SKILL_ROOT = Path(__file__).resolve().parents[1]
HELPER_PATH = SKILL_ROOT / "scripts" / "ast_grep_helper.py"


def load_helper():
    spec = importlib.util.spec_from_file_location("ast_grep_helper_under_test", HELPER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load helper from {HELPER_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HELPER = load_helper()


class ProbeAstGrepCandidateTests(unittest.TestCase):
    def make_candidate(self, directory: Path, name: str = "sg") -> Path:
        candidate = directory / name
        candidate.write_text("placeholder", encoding="utf-8")
        candidate.chmod(candidate.stat().st_mode | stat.S_IXUSR)
        return candidate

    def test_accepts_valid_ast_grep_version_output(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            candidate = self.make_candidate(Path(temp_dir))
            completed = subprocess.CompletedProcess(
                [str(candidate), "--version"], 0, "ast-grep 0.37.0\n", ""
            )
            with patch.object(HELPER.subprocess, "run", return_value=completed) as run:
                self.assertEqual(HELPER.probe_ast_grep_candidate(candidate), candidate.resolve())

            run.assert_called_once_with(
                [str(candidate.resolve()), "--version"],
                capture_output=True,
                text=True,
                timeout=5.0,
                check=False,
            )

    def test_rejects_nonzero_version_command(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            candidate = self.make_candidate(Path(temp_dir))
            completed = subprocess.CompletedProcess(
                [str(candidate), "--version"], 1, "ast-grep 0.37.0\n", "error"
            )
            with patch.object(HELPER.subprocess, "run", return_value=completed):
                self.assertIsNone(HELPER.probe_ast_grep_candidate(candidate))

    def test_rejects_probe_timeout(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            candidate = self.make_candidate(Path(temp_dir))
            with patch.object(
                HELPER.subprocess,
                "run",
                side_effect=subprocess.TimeoutExpired([str(candidate), "--version"], 5.0),
            ):
                self.assertIsNone(HELPER.probe_ast_grep_candidate(candidate))

    def test_rejects_unrelated_sg_version_output(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            candidate = self.make_candidate(Path(temp_dir))
            completed = subprocess.CompletedProcess(
                [str(candidate), "--version"], 0, "setgroups (util-linux) 2.40\n", ""
            )
            with patch.object(HELPER.subprocess, "run", return_value=completed):
                self.assertIsNone(HELPER.probe_ast_grep_candidate(candidate))

    def test_relative_candidate_uses_path_lookup(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            candidate = self.make_candidate(Path(temp_dir))
            completed = subprocess.CompletedProcess(
                [str(candidate), "--version"], 0, "", "AST-GREP 0.37.0\n"
            )
            with (
                patch.object(HELPER.shutil, "which", return_value=str(candidate)) as which,
                patch.object(HELPER.subprocess, "run", return_value=completed),
            ):
                self.assertEqual(HELPER.probe_ast_grep_candidate("sg"), candidate.resolve())

            which.assert_called_once_with("sg")


class ResolverFallbackTests(unittest.TestCase):
    def test_invalid_env_candidate_falls_through_runtime_cache_to_path(self) -> None:
        expected = Path("C:/tools/ast-grep.exe")
        with (
            patch.dict(os.environ, {"DSMM_AST_GREP_SG_PATH": "C:/invalid/sg.exe"}),
            patch.object(HELPER, "probe_ast_grep_candidate", return_value=None) as probe,
            patch.object(HELPER, "dsmm_runtime_binary", return_value=None) as runtime,
            patch.object(HELPER, "cached_binary", return_value=None) as cached,
            patch.object(HELPER, "which_binary", return_value=expected) as path,
            patch.object(HELPER, "homebrew_binary") as homebrew,
        ):
            self.assertEqual(HELPER.resolve_binary(), expected)

        probe.assert_called_once_with(Path("C:/invalid/sg.exe"))
        runtime.assert_called_once_with()
        cached.assert_called_once_with()
        path.assert_called_once_with()
        homebrew.assert_not_called()

    def test_all_resolver_tiers_delegate_to_the_strict_probe(self) -> None:
        source = HELPER_PATH.read_text(encoding="utf-8")
        helper_start = source.index("def _first_valid_candidate(")
        helper_end = source.index("\ndef cached_binary(", helper_start)
        self.assertIn("probe_ast_grep_candidate", source[helper_start:helper_end])
        for function_name in (
            "dsmm_env_binary",
            "dsmm_runtime_binary",
            "cached_binary",
            "which_binary",
            "homebrew_binary",
        ):
            start = source.index(f"def {function_name}(")
            next_function = source.find("\ndef ", start + 1)
            body = source[start:next_function if next_function != -1 else None]
            self.assertIn("_first_valid_candidate", body, function_name)

if __name__ == "__main__":
    unittest.main()
