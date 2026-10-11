"""Prepare an isolated download comparison; never execute or publish a release."""

import argparse
import hashlib
import json
import shutil
import subprocess
import zipfile
from pathlib import Path


EXPECTED_SOURCE_SHA256 = "daf671cefe8a73e74a44cbed95a0650d6ed5b7abd5dec5d0b0eb130b36665070"
WHISPER = "resources/app.asar.unpacked/desktop/bin/windows/whisper-server.exe"
EXPECTED_WHISPER_SHA256 = "62a49bcc62db4ff39cb36d41c59c6ecf139950a675f9bb5bc734ba9598d32968"


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def entries(path):
    result = {}
    with zipfile.ZipFile(path) as archive:
        for info in archive.infolist():
            if info.filename in result:
                raise ValueError("Duplicate archive entry: " + info.filename)
            with archive.open(info) as stream:
                result[info.filename] = {
                    "sha256": hashlib.file_digest(stream, "sha256").hexdigest(),
                    "bytes": info.file_size,
                    "compressedBytes": info.compress_size,
                    "compression": info.compress_type,
                    "crc32": info.CRC,
                    "modified": list(info.date_time),
                    "attributes": info.external_attr,
                }
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    if digest(args.source) != EXPECTED_SOURCE_SHA256:
        raise ValueError("This experiment requires the exact previously scanned portable ZIP.")
    original = entries(args.source)
    if original.get(WHISPER, {}).get("sha256") != EXPECTED_WHISPER_SHA256:
        raise ValueError("Unexpected Whisper executable.")
    args.destination.mkdir(parents=True, exist_ok=False)
    control_dir = args.destination / "control"
    candidate_dir = args.destination / "without-whisper"
    evidence_dir = args.destination / "evidence"
    for directory in (control_dir, candidate_dir, evidence_dir):
        directory.mkdir()
    control = control_dir / args.source.name
    candidate = candidate_dir / args.source.name
    shutil.copy2(args.source, control)
    shutil.copy2(args.source, candidate)
    # zip -d copies retained compressed entries without recompressing their data.
    subprocess.run(["zip", "-d", str(candidate.resolve()), WHISPER], check=True)
    modified = entries(candidate)
    expected = {name: data for name, data in original.items() if name != WHISPER}
    if modified != expected:
        raise ValueError("An entry other than the selected Whisper executable changed.")
    if digest(control) != EXPECTED_SOURCE_SHA256 or digest(args.source) != EXPECTED_SOURCE_SHA256:
        raise ValueError("Source or control changed.")
    report = {
        "purpose": "Diagnostic download comparison only; the candidate cannot run local transcription.",
        "sourceCommit": "2eef248013a8a7095be875717b94232910bedea7",
        "sourceRun": "https://github.com/Eslsamu/callside/actions/runs/38023851945",
        "sourceArtifact": "https://github.com/Eslsamu/callside/actions/runs/38023851945/artifacts/11659492017",
        "sourceArtifactContainsInstallerAndPortable": True,
        "comparisonContainsPortableOnly": True,
        "installerOmittedFromBoth": "The installer also embeds Whisper, so retaining it would not isolate the component.",
        "control": {"sha256": digest(control), "bytes": control.stat().st_size, "entries": len(original)},
        "withoutWhisper": {"sha256": digest(candidate), "bytes": candidate.stat().st_size, "entries": len(modified)},
        "removed": {"path": WHISPER, **original[WHISPER]},
        "retainedEntriesIdentical": True,
        "sourceUnchanged": True,
        "fileExecution": False,
        "interpretation": {
            "controlBlockedCandidateAllowed": "Supports an association with this executable; different ZIP hashes and reputation prevent a definitive causal conclusion.",
            "bothBlocked": "Removing this executable alone is insufficient; it does not rule out multiple contributing signals.",
            "bothAllowed": "No evidence implicating the helper in this comparison; the original outer artifact also includes an installer and has different packaging/reputation.",
            "controlAllowedCandidateBlocked": "Inconclusive; removal did not improve download acceptance.",
        },
        "browserResults": "Pending. Antivirus results are not browser acceptance results.",
    }
    (evidence_dir / "comparison.json").write_text(json.dumps(report, indent=2) + "\n")
    (evidence_dir / "entries-control.json").write_text(json.dumps(original, indent=2) + "\n")
    (evidence_dir / "entries-without-whisper.json").write_text(json.dumps(modified, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
