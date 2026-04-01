#!/usr/bin/env bash
PORT=3009

# Kill any process already using the port
PID=$(lsof -ti :"$PORT" 2>/dev/null)
if [ -n "$PID" ]; then
  echo "Port $PORT is in use (PID $PID). Killing..."
  kill -9 $PID
  sleep 0.5
fi

PORT=$PORT bun run src/index.ts
