#!/bin/sh
# Сторож: раз в 5 минут проверяем /health и поднимаем сервис, если он не отвечает.
# Запись только при перезапуске — в спокойный день лог пустой.
LOG=/opt/stambul-pult/data/watch.log
if ! curl -fsS --max-time 8 http://127.0.0.1:8907/health >/dev/null 2>&1; then
  echo "$(date -Is) /health молчит — перезапускаю stambul-pult" >> "$LOG"
  systemctl restart stambul-pult
  sleep 5
  if curl -fsS --max-time 8 http://127.0.0.1:8907/health >/dev/null 2>&1; then
    echo "$(date -Is) поднялся" >> "$LOG"
  else
    echo "$(date -Is) НЕ поднялся после перезапуска" >> "$LOG"
  fi
  tail -n 200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
