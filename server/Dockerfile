# PDF Studio server: LibreOffice + Tesseract (English, Hindi) + Python API.
FROM python:3.12-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui libreoffice-draw-nogui \
      tesseract-ocr tesseract-ocr-eng tesseract-ocr-hin \
      fonts-noto-core fonts-noto-cjk fonts-dejavu-core fonts-liberation2 \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 10001 pdfstudio
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY THIRD-PARTY-NOTICES.txt ./

USER pdfstudio
ENV PDFSTUDIO_DATA_DIR=/home/pdfstudio/data HOME=/home/pdfstudio
EXPOSE 8787
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8787", "--workers", "2"]
