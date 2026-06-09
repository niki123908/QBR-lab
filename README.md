# QBR — Deployment Guide

## Requirements

| Component  | Version                                                           |
| ---------- | ----------------------------------------------------------------- |
| Node.js    | 20+                                                               |
| Python     | 3.11+                                                             |
| Docker     | Required for PostgreSQL in development and full Docker deployment |
| PostgreSQL | Required                                                          |

---

## 1. Environment Setup

Initialize environment files:

```bash
cp .env.example .env
cp frontend/.env.example frontend/.env
```

### Root `.env`

| Variable        | Default Value                             |
| --------------- | ----------------------------------------- |
| `DATABASE_URL`  | `postgresql://qbr:qbr@127.0.0.1:5433/qbr` |
| `POSTGRES_PORT` | `5433`                                    |
| `BACKEND_PORT`  | `8000`                                    |
| `FRONTEND_PORT` | `5173`                                    |

### `frontend/.env`

```env
VITE_API_BASE=/api
```

The frontend accesses the backend through the Vite proxy (`/api` → `127.0.0.1:8000`).

Artifacts are stored in:

```text
storage/artifacts/
```

Backend and worker services must have access to this directory.

---

## 2. Initial Installation

From the project root:

```bash
npm install
pip install -r backend/requirements.txt
```

Using a Python virtual environment:

```bash
python -m venv .venv

# Windows
.venv\Scripts\activate

# Linux/macOS
source .venv/bin/activate

pip install -r backend/requirements.txt
```

---

## 3. Development Mode

Start the development environment:

```bash
npm run dev
```

This launches:

* PostgreSQL container
* Frontend (Vite)
* Backend API
* Three worker processes

### Endpoints

| Service      | URL                          |
| ------------ | ---------------------------- |
| Frontend     | http://localhost:5173        |
| Backend API  | http://localhost:8000        |
| Health Check | http://localhost:8000/health |

### Additional Commands

```bash
npm run dev:postgres
npm run dev:worker
```

---

## 4. Sharing a Development Instance

Start the development environment and create a Cloudflare Tunnel:

```bash
npm run share
```

Alternatively:

```bash
npm run dev
npm run tunnel
```

The generated Cloudflare URL can be used to access the application remotely.

Only the frontend port (`5173`) is exposed. API requests are routed through the Vite proxy.

---

## 5. Docker Compose Deployment

Start the full stack:

```bash
cp .env.example .env
cp frontend/.env.example frontend/.env

docker compose up --build
```

Services:

| Service           | URL                   |
| ----------------- | --------------------- |
| Frontend          | http://localhost:5173 |
| Backend API       | http://localhost:8000 |
| PostgreSQL (host) | 127.0.0.1:5433        |

Within the Docker network, backend and worker services use:

```text
postgresql://qbr:qbr@postgres:5432/qbr
```

Stop the stack:

```bash
docker compose down
```

---

## 6. Ubuntu (22.04 / 24.04)

### Native Development

```bash
sudo apt update

sudo apt install -y \
    python3 \
    python3-pip \
    python3-venv \
    git \
    curl \
    build-essential \
    docker.io \
    docker-compose-v2

curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

sudo usermod -aG docker "$USER"

cd QBR

python3 -m venv .venv
source .venv/bin/activate

pip install -r backend/requirements.txt

cp .env.example .env
cp frontend/.env.example frontend/.env

npm install
npm run dev
```

### Docker Deployment

```bash
cd QBR

cp .env.example .env
cp frontend/.env.example frontend/.env

docker compose up --build -d

docker compose logs -f backend worker-1
```

### Local PostgreSQL Installation

```bash
sudo apt install -y postgresql postgresql-contrib

sudo -u postgres createuser -P qbr
sudo -u postgres createdb -O qbr qbr
```

Update `.env`:

```env
DATABASE_URL=postgresql://qbr:<password>@127.0.0.1:5432/qbr
POSTGRES_PORT=5432
```

Start the application using the preferred runtime method (e.g. `npm run dev`, systemd, or Docker).

---

## 7. Troubleshooting

### PostgreSQL Authentication Failure

```text
password authentication failed for user "qbr"
```

Update `.env`:

```env
POSTGRES_PORT=5433
DATABASE_URL=postgresql://qbr:qbr@127.0.0.1:5433/qbr
```

Then restart PostgreSQL:

```bash
docker compose down
docker compose up postgres -d --wait

npm run dev
```

### Port 5173 Already in Use

Terminate the existing process using port `5173` and restart:

```bash
npm run dev
```

### Cloudflare Tunnel Command Not Found

Use the project scripts:

```bash
npm run tunnel
```

or

```bash
npm run share
```

### API Requests Fail Through Tunnel

Verify:

```env
VITE_API_BASE=/api
```

Then restart the frontend development server.
