FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    COMFYUI_PATH=/opt/ComfyUI

ARG COMFYUI_COMMIT=093d571b83e7a79833200e199b46b9f5a62217f9

RUN apt-get update && apt-get install -y --no-install-recommends \
      git python3 python3-pip python3-venv libgl1 libglib2.0-0 curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN git init "$COMFYUI_PATH" \
    && git -C "$COMFYUI_PATH" remote add origin https://github.com/Comfy-Org/ComfyUI.git \
    && git -C "$COMFYUI_PATH" fetch --depth 1 origin "$COMFYUI_COMMIT" \
    && git -C "$COMFYUI_PATH" checkout --detach FETCH_HEAD \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r "$COMFYUI_PATH/requirements.txt"

WORKDIR /opt/gateway
COPY requirements.txt .
RUN /opt/venv/bin/pip install --no-cache-dir -r requirements.txt
COPY app.py comfy_client.py security.py token_guard.py worker_agent.py ./
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8791
ENTRYPOINT ["/entrypoint.sh"]
