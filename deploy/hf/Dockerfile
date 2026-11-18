# Hugging Face Spaces (Docker SDK) image for the YouBike optimizer.
FROM python:3.12-slim

RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user PATH=/home/user/.local/bin:$PATH PYTHONUNBUFFERED=1 TZ=Asia/Taipei
WORKDIR /home/user/app

COPY --chown=user requirements.txt .
RUN pip install --no-cache-dir --user -r requirements.txt

COPY --chown=user . .
# Ephemeral disk: data is restored from / backed up to the private HF dataset
# (UBIKE_BACKUP_REPO) by ubike/cloud.py.
ENV UBIKE_DATA_DIR=/home/user/app/data UBIKE_ARCHIVE_RAW=0

EXPOSE 7860
CMD ["python", "-m", "ubike", "serve", "--host", "0.0.0.0", "--port", "7860"]
