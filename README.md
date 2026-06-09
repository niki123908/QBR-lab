# QBR — Hướng dẫn triển khai

## Yêu cầu

| Thành phần | Phiên bản |
|------------|-----------|
| Node.js | 20+ |
| Python | 3.11+ |
| Docker | Bắt buộc cho Postgres dev (`npm run dev`) và stack Docker đầy đủ |
| PostgreSQL | Bắt buộc (SQLite không còn hỗ trợ) |

---

## 1. Cấu hình môi trường

Tạo file env từ mẫu (chỉ cần làm một lần):

```bash
cp .env.example .env
cp frontend/.env.example frontend/.env
```

### `QBR/.env`

| Biến | Mặc định | Ghi chú |
|------|----------|---------|
| `DATABASE_URL` | `postgresql://qbr:qbr@127.0.0.1:5433/qbr` | Kết nối từ máy host tới Postgres Docker |
| `POSTGRES_PORT` | `5433` | Dùng **5433** nếu máy đã có Postgres khác ở port 5432 (thường gặp trên Windows) |
| `BACKEND_PORT` | `8000` | API |
| `FRONTEND_PORT` | `5173` | UI (dev) |

### `QBR/frontend/.env`

```env
VITE_API_BASE=/api
```

UI và API dùng **cùng một cổng** qua Vite proxy (`/api` → `127.0.0.1:8000`). Phù hợp cho Cloudflare Tunnel.

Dữ liệu artifact lưu tại `storage/artifacts/` — backend và worker phải cùng thấy thư mục này.

---

## 2. Cài đặt lần đầu

Trong thư mục `QBR/`:

```bash
npm install
pip install -r backend/requirements.txt
```

Khuyến nghị dùng Python venv:

```bash
python -m venv .venv
# Windows:  .venv\Scripts\activate
# Linux:    source .venv/bin/activate
pip install -r backend/requirements.txt
```

---

## 3. Chạy dev (khuyến nghị hàng ngày)

```bash
npm run dev
```

Lệnh này tự động:

1. Khởi động Postgres container (`predev`)
2. Frontend Vite — **http://localhost:5173**
3. Backend API — http://localhost:8000 (proxy qua UI tại `/api`)
4. **3 worker** xử lý queue

### Kiểm tra

| Mục | URL / lệnh |
|-----|------------|
| UI | http://localhost:5173 |
| API trực tiếp | http://localhost:8000/health |
| Postgres container | `docker compose ps postgres` |

### Lệnh phụ

```bash
npm run dev:postgres   # chỉ Postgres
npm run dev:worker     # một worker (debug)
```

---

## 4. Chia sẻ cho người khác (Cloudflare Tunnel)

Cần `npm install` (đã có package `cloudflared` trong project).

**Một lệnh** — dev + tunnel:

```bash
npm run share
```

Khi tunnel sẵn sàng, terminal in khối:

```
============================================================
  CHIA SE LINK NAY CHO NGUOI KHAC:
  https://xxxx.trycloudflare.com
============================================================
```

**Hai terminal** (dev đã chạy rồi):

```bash
npm run dev      # terminal 1
npm run tunnel   # terminal 2
```

Chỉ tunnel **một cổng 5173** — không cần expose 8000.

---

## 5. Docker Compose (full stack)

Chạy toàn bộ trong container: Postgres + backend + frontend + 3 worker.

```bash
cp .env.example .env
cp frontend/.env.example frontend/.env
docker compose up --build
```

| Dịch vụ | URL |
|---------|-----|
| UI | http://localhost:5173 |
| API | http://localhost:8000 |
| Postgres (host) | `127.0.0.1:5433` (theo `POSTGRES_PORT` trong `.env`) |

Trong container, backend/worker dùng `DATABASE_URL=postgresql://qbr:qbr@postgres:5432/qbr` (Compose tự gán).

Dừng stack:

```bash
docker compose down
```

---

## 6. Ubuntu (22.04 / 24.04)

### Dev native

```bash
sudo apt update
sudo apt install -y python3 python3-pip python3-venv git curl build-essential docker.io docker-compose-v2
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo usermod -aG docker "$USER"   # đăng xuất / đăng nhập lại

cd QBR
python3 -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt
cp .env.example .env && cp frontend/.env.example frontend/.env
npm install
npm run dev
```

### Server — Docker Compose

```bash
cd QBR
cp .env.example .env
cp frontend/.env.example frontend/.env
docker compose up --build -d
docker compose logs -f backend worker-1
```

### Postgres cài trực tiếp (không Docker DB)

```bash
sudo apt install -y postgresql postgresql-contrib
sudo -u postgres createuser -P qbr
sudo -u postgres createdb -O qbr qbr
```

Sửa `.env`:

```env
DATABASE_URL=postgresql://qbr:<mat-khau>@127.0.0.1:5432/qbr
POSTGRES_PORT=5432
```

Chạy backend + worker (vd. `npm run dev` hoặc systemd).

---

## 7. Xử lý sự cố thường gặp

### `password authentication failed for user "qbr"`

Máy có Postgres khác đang chiếm port 5432. Trong `.env` đặt:

```env
POSTGRES_PORT=5433
DATABASE_URL=postgresql://qbr:qbr@127.0.0.1:5433/qbr
```

Rồi:

```bash
docker compose down
docker compose up postgres -d --wait
npm run dev
```

### `Port 5173 is in use`

Tắt session `npm run dev` cũ (Ctrl+C) hoặc kill process Node/Python thừa, chạy lại `npm run dev`.

### `cloudflared` không nhận lệnh

Dùng script qua npm (không cần cài global):

```bash
npm run tunnel
# hoặc
npm run share
```

### UI load nhưng API lỗi khi dùng tunnel

Đảm bảo `frontend/.env` có `VITE_API_BASE=/api` và chạy lại `npm run dev`.
