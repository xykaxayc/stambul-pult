#!/usr/bin/env python3
"""Генератор QR-наклеек столов «Серп».

Читает config.json, считает подпись каждого стола (та же, что проверяет сервер)
и кладёт картинки в public/qr/ под именем, которое само содержит подпись —
угадать имя файла нельзя.

Запуск:  python3 tools/make-qr.py            (нужен модуль qrcode)
После смены qrSecret — перегенерировать и ПЕРЕПЕЧАТАТЬ все наклейки.
"""
import hashlib
import hmac
import json
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = json.load(open(os.path.join(ROOT, "config.json"), encoding="utf-8"))
QR_DIR = os.path.join(ROOT, "public", "qr")
BASE = sys.argv[1] if len(sys.argv) > 1 else "https://serp.stambul42.ru"

try:
    import qrcode
except ImportError:
    sys.exit("нет модуля qrcode:  pip install qrcode pillow")


def token(n: int) -> str:
    return hmac.new(CFG["qrSecret"].encode(), f"table:{n}".encode(), hashlib.sha256).hexdigest()[:10]


if os.path.isdir(QR_DIR):
    shutil.rmtree(QR_DIR)          # старые наклейки больше не действуют
os.makedirs(QR_DIR)

index = []
for n in range(1, CFG["tables"] + 1):
    t = token(n)
    url = f"{BASE}/t/{n}-{t}"
    name = f"t-{n}-{t}.png"
    qrcode.make(url, box_size=12, border=2).save(os.path.join(QR_DIR, name))
    index.append({"n": n, "url": url, "img": f"/qr/{name}"})

# список НЕ кладём рядом с картинками: он раскрыл бы все адреса столов.
# Страница печати берёт его через /api/qr (под ключом пульта).
print(f"готово: {len(index)} наклеек в public/qr/")
print(f"пример: {index[0]['url']}")
