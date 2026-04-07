#!/usr/bin/env python3
"""Best-effort vault text extraction for wiki-skill.

Supports:
- plain text / markdown / json / csv
- docx / pptx / xlsx via zip+xml extraction
- pdf via Spotlight metadata or strings fallback
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree


TEXT_EXTS = {".txt", ".md", ".markdown", ".json", ".csv", ".tsv", ".yaml", ".yml"}
ZIP_EXTS = {".docx", ".pptx", ".xlsx"}


def emit(payload: dict[str, object]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")


def read_text_direct(path: Path) -> str:
    for encoding in ("utf-8", "utf-16", "latin-1"):
        try:
            text = path.read_text(encoding=encoding, errors="ignore")
        except Exception:
            continue
        cleaned = text.replace("\x00", " ").strip()
        if cleaned:
            return cleaned
    return ""


def printable_ratio(text: str) -> float:
    if not text:
        return 0.0
    printable = sum(1 for char in text if char.isprintable() or char in "\n\r\t")
    return printable / max(len(text), 1)


def try_plain_text_from_any_file(path: Path) -> str:
    text = read_text_direct(path)
    if printable_ratio(text) >= 0.85:
        return text
    return ""


def strip_xml_text(xml_bytes: bytes) -> str:
    try:
        root = ElementTree.fromstring(xml_bytes)
        text = "".join(fragment.strip() + " " for fragment in root.itertext() if fragment.strip())
        return re.sub(r"\s+", " ", text).strip()
    except Exception:
        return ""


def extract_zip_xml(path: Path) -> str:
    snippets: list[str] = []
    try:
        with zipfile.ZipFile(path) as archive:
            names = sorted(archive.namelist())
            for name in names:
                lower = name.lower()
                if path.suffix.lower() == ".docx" and not lower.startswith("word/"):
                    continue
                if path.suffix.lower() == ".pptx" and not lower.startswith("ppt/slides/"):
                    continue
                if path.suffix.lower() == ".xlsx" and not (
                    lower.startswith("xl/sharedstrings") or lower.startswith("xl/worksheets/")
                ):
                    continue
                if not lower.endswith(".xml"):
                    continue
                text = strip_xml_text(archive.read(name))
                if text:
                    snippets.append(text)
    except Exception:
        return ""

    return "\n".join(snippets).strip()


def extract_pdf(path: Path) -> str:
    try:
        result = subprocess.run(
            ["/usr/bin/mdls", "-raw", "-name", "kMDItemTextContent", str(path)],
            capture_output=True,
            text=True,
            check=False,
        )
        text = (result.stdout or "").strip()
        if text and text != "(null)":
            return text
    except Exception:
        pass

    try:
        result = subprocess.run(
            ["/usr/bin/strings", "-n", "6", str(path)],
            capture_output=True,
            text=True,
            check=False,
        )
        lines = [line.strip() for line in (result.stdout or "").splitlines() if line.strip()]
        if lines:
            return "\n".join(lines[:400])
    except Exception:
        pass

    return ""


def extract_text(path: Path) -> str:
    ext = path.suffix.lower()

    direct = try_plain_text_from_any_file(path)
    if direct and (ext in TEXT_EXTS or ext in {".pdf", ".docx", ".pptx", ".xlsx"}):
        return direct

    if ext in TEXT_EXTS:
        return direct
    if ext in ZIP_EXTS:
        zipped = extract_zip_xml(path)
        return zipped or direct
    if ext == ".pdf":
        pdf_text = extract_pdf(path)
        return pdf_text or direct

    return direct


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("path")
    args = parser.parse_args()

    file_path = Path(args.path).expanduser().resolve()
    if not file_path.exists() or not file_path.is_file():
        emit({"error": f"File not found: {file_path}"})
        return 1

    text = extract_text(file_path)
    emit({"text": text})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
