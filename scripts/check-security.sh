#!/bin/bash

yarn audit
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]
then
  echo "The script ran ok"
  exit 0
else
  echo "The script failed" >&2
  exit 1
fi

