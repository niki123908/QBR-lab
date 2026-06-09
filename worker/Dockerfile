FROM python:3.11-slim

WORKDIR /app

COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir -r /app/backend/requirements.txt

COPY backend /app/backend
COPY worker/jobs /app/jobs

ENV PYTHONPATH=/app/backend
ENV QBR_ROOT=/app

CMD ["python", "jobs/worker_main.py"]
