#!/usr/bin/env python3
"""Score annotated clips with overlap included, zero collar; write mapped error intervals."""
import argparse
import json
from pathlib import Path
from pyannote.core import Annotation, Segment, Timeline
from pyannote.metrics.diarization import DiarizationErrorRate

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("directory", type=Path)
args = parser.parse_args()
reports = []
for item in json.loads((args.directory / "manifest.json").read_text()):
    name = item["id"]
    reference = Annotation(uri=name)
    for i, line in enumerate((args.directory / f"{name}.rttm").read_text().splitlines()):
        row = line.split()
        start, duration = float(row[3]), float(row[4])
        reference[Segment(start, start + duration), i] = row[7]
    for engine in ("lseend", "lseend-dihard3", "diart", "openai", "elevenlabs"):
        path = args.directory / f"{name}.{engine}.json"
        if not path.exists():
            continue
        data = json.loads(path.read_text())
        hypothesis = Annotation(uri=name)
        for i, row in enumerate(data["segments"]):
            start = max(0, row.get("start", row.get("startTimeSeconds")))
            end = min(item["duration"], row.get("end", row.get("endTimeSeconds")))
            if end > start:
                hypothesis[Segment(start, end), i] = row["speaker"]
        metric = DiarizationErrorRate(collar=0, skip_overlap=False)
        region = Timeline([Segment(0, item["duration"])])
        details = metric(reference, hypothesis, uem=region, detailed=True)
        mapping = metric.optimal_mapping(reference, hypothesis, uem=region)
        mapped = hypothesis.rename_labels(mapping=mapping)
        errors = []
        boundaries = sorted({0, item["duration"]} | {v for ann in (reference,mapped) for t in ann.get_timeline() for v in (t.start,t.end)})
        for start,end in zip(boundaries,boundaries[1:]):
            mid = (start+end)/2
            truth = sorted({s for t,_,s in reference.itertracks(yield_label=True) if t.start <= mid < t.end})
            predicted = sorted({s for t,_,s in mapped.itertracks(yield_label=True) if t.start <= mid < t.end})
            if truth != predicted:
                if errors and errors[-1]["end"] == start and errors[-1]["expected"] == truth and errors[-1]["predicted"] == predicted:
                    errors[-1]["end"] = end
                else:
                    errors.append(dict(start=start,end=end,expected=truth,predicted=predicted))
        report = dict(clip=name,engine=engine,reference_speakers=len(reference.labels()),
                      predicted_speakers=len(hypothesis.labels()),metrics=details,mapping=mapping,
                      processing_seconds=data.get("processing_seconds",data.get("processingTimeSeconds")),
                      longest_errors=sorted(errors,key=lambda x:x["end"]-x["start"],reverse=True)[:15])
        reports.append(report)
(args.directory / "scores.json").write_text(json.dumps(reports,indent=2))
for r in reports:
    print(r["clip"],r["engine"],f'DER {r["metrics"]["diarization error rate"]:.1%}',
          f'speakers {r["predicted_speakers"]}/{r["reference_speakers"]}',f'{r["processing_seconds"]:.2f}s')
