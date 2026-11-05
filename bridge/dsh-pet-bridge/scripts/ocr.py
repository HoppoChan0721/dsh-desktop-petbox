"""窥屏用 OCR：RapidOCR（PP-OCR 模型的 onnx 版，纯 CPU、离线跑、不联网）。

用法：
    ocr-venv\\Scripts\\python.exe ocr.py <图片路径> <输出 JSON 路径> [最低置信度]

输出：{"ok": true, "engine": "rapidocr", "lines": ["...", "..."], "ms": 123}
失败也写一份 JSON：{"ok": false, "error": "..."}——调用方（peek-window.ps1）看到 ok:false 就回落 Windows OCR。
"""
import json
import sys
import time


def write(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)


def main():
    if len(sys.argv) < 3:
        print("usage: ocr.py <image> <out.json> [min_score]", file=sys.stderr)
        return 2
    img, out = sys.argv[1], sys.argv[2]
    min_score = float(sys.argv[3]) if len(sys.argv) > 3 else 0.5
    t0 = time.time()
    try:
        from rapidocr import RapidOCR  # 延迟导入：装坏了也是「这轮跳过」，不是崩

        engine = RapidOCR()
        res = engine(img)
        txts = list(getattr(res, "txts", None) or [])
        scores = list(getattr(res, "scores", None) or [])
        lines = []
        for i, t in enumerate(txts):
            s = float(scores[i]) if i < len(scores) else 1.0
            t = str(t).strip()
            if t and s >= min_score:
                lines.append(t)
        write(out, {"ok": True, "engine": "rapidocr", "lines": lines,
                    "ms": int((time.time() - t0) * 1000)})
        return 0
    except Exception as e:  # noqa: BLE001
        write(out, {"ok": False, "engine": "rapidocr", "error": str(e)[:300],
                    "ms": int((time.time() - t0) * 1000)})
        return 1


if __name__ == "__main__":
    sys.exit(main())
