# ApnaShift Backend — Ubuntu 24 (ARM, Oracle Free Tier) Deployment

> Beginner guide. Har step me **har command ke aage one-line explanation** hai.
> Placeholders badlo: `api.example.com` = tumhara domain, `TU...` kuch nahi — repo URL wali line me apna GitHub URL likho.
> Assumption: fresh **Ubuntu 24.04 ARM** (Ampere) instance, SSH ho gaya hai, domain ka **A record** server ke public IP par bana diya hai.

Files in this change:

- `ecosystem.config.cjs` — PM2 process file (reboot par auto-start ke saath)
- `deploy/nginx-apnashift.conf` — Nginx reverse proxy (80; 443 Certbot jodega)
- `deploy/backup.sh` — daily `pg_dump` + 7-day rotation
- `deploy/smoke.sh` — deploy ke baad non-mutating checklist (DB me kuch nahi likhta)

---

## 0. Server par pehli baar login + update

```bash
ssh ubuntu@<server-ip>                        # server par login karo
sudo apt-get update                           # package list fresh karo (install se pehle zaroori)
sudo apt-get upgrade -y                       # OS security patches lagao
sudo apt-get install -y git curl openssl      # git (clone), curl (health check), openssl (password/secret banane)
```

## 1. Node 20 + PostgreSQL + least-privilege DB user

Ubuntu 24 ke default repo me Node 18 hai — app ko **>= 20** chahiye (`package.json` engines), isliye NodeSource se 20 lo. ARM64 par yehi setup kaam karta hai, alag step nahi hai.

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -   # Node 20 ka apt repo jodo (ARM64 supported)
sudo apt-get install -y nodejs                                       # Node 20 + npm install karo
node -v && npm -v                                                    # v20+ dikhe tabhi aage badho
sudo apt-get install -y python3 make g++                             # bcrypt (native module) compile ke liye build tools
sudo apt-get install -y postgresql postgresql-contrib               # Postgres 16 + extra utilities
sudo systemctl enable --now postgresql                               # reboot par Postgres khud start ho
```

Ab DB user banao — **strong password, superuser rights nahi**:

```bash
DB_PASS="$(openssl rand -base64 24)"              # 24-byte random password banao (yaad karne ki zaroorat nahi)
echo "$DB_PASS"                                   # ise abhi copy karke password manager me rakh lo (neeche .env me lagega)
sudo -u postgres psql -c "CREATE USER apnashift WITH PASSWORD '$DB_PASS' NOSUPERUSER NOCREATEDB NOCREATEROLE;"  # sirf login wala normal user, koi admin right nahi
sudo -u postgres psql -c "CREATE DATABASE apnashift OWNER apnashift;"                                          # app ka database, owner yehi user
sudo -u postgres psql -c "\du"                    # verify: apnashift user me Superuser/Create DB blank hone chahiye
```

> `NOSUPERUSER NOCREATEDB NOCREATEROLE` default bhi hain, par explicitly likha hai taaki koi galti se admin user na bana de. App ko apne DB par full rights owner hone se mil jate hain — alag GRANT ki zaroorat nahi.

## 2. Clone, install, `.env`, migrate

```bash
sudo mkdir -p /opt/apnashift                          # app ka fixed ghar (PM2/nginx/backup sab yehi path mante hain)
sudo chown ubuntu:ubuntu /opt/apnashift               # ubuntu user ko likhne ka haq do (sudo bina kaam ho)
cd /opt/apnashift                                     # is folder me clone karo
git clone https://github.com/<tumhara-user>/apnashift.git .   # apna repo URL likho; dot = isi folder me
cd apnashift-backend                                  # asli app is subfolder me hai (package.json yahin hai)
npm ci --omit=dev                                     # lockfile se exact prod deps (devDeps nahi — free tier RAM/disk bache)
cp .env.example .env                                  # config template copy karo
chmod 600 .env                                        # sirf tum padh sako (password/secret isme hai)
nano .env                                             # values bharo — neeche wali list dekho
```

`.env` me ye values **production wali** rakho (bina inke server start nahi hoga):

```ini
PORT=3000
NODE_ENV=production
DATABASE_URL=postgres://apnashift:<DB_PASS>@localhost:5432/apnashift   # step 1 wala password
JWT_SECRET=<openssl rand -hex 32 ka output, 64 chars>                  # min 32 chars, warna server exit(1)
CORS_ORIGIN=https://tumhara-frontend.com                               # kabhi * mat rakho prod me
TRUST_PROXY=1                                                          # REQUIRED: nginx ke peeche rate-limit sahi IP dekhe
DISTANCE_PROVIDER=haversine                                            # free default; google paid hai
```

```bash
openssl rand -hex 32                              # JWT_SECRET banao (64 hex chars — 32-char minimum se double)
npm run db:migrate                                # tables + migrations + pricing seed (additive/IF NOT EXISTS — dobara chalana safe)
```

> ⚠️ **Destructive warning:** `db:seed` ya `TRUNCATE` jaise commands prod me **kabhi mat chalao** — seed sirf migrate ke andar wali chalti hai (custom pricing overwrite nahi karti). Agar kabhi fresh DB chahiye to pehle section 6 ka backup lo.

## 3. PM2 — app hamesha chale, reboot par wapas aaye

```bash
sudo npm i -g pm2                                  # process manager global install karo
pm2 start ecosystem.config.cjs --env production    # app start karo (NODE_ENV=production ke saath)
pm2 logs apnashift-api --lines 30                  # JWT/DB error ho to yahin dikhega (pehle yahi dekho)
pm2 save                                           # current process list save karo (reboot resume ke liye)
pm2 startup                                        # ye ek sudo command print karega...
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu   # ...use copy-paste karke chalao (reboot persistence)
```

> `ecosystem.config.cjs` hi hai (`.js` nahi) — `package.json` me `"type": "module"` hai, isliye `.js` me `module.exports` toot jayega. `instances: 1` free-tier RAM ke liye hai; `max_memory_restart: 350M` leak se bachata hai.
> Useful: `pm2 status` (list), `pm2 restart apnashift-api`, `pm2 logs apnashift-api`.

## 4. Nginx reverse proxy + free HTTPS (Certbot)

Node ko **directly internet par mat kholo** — sirf `127.0.0.1:3000` par sune, bahar se Nginx baat kare.

```bash
sudo apt-get install -y nginx                                  # reverse proxy install karo
sudo cp deploy/nginx-apnashift.conf /etc/nginx/sites-available/apnashift   # repo wali config lagao
sudo nano /etc/nginx/sites-available/apnashift                 # api.example.com -> apna domain (2 jagah nahi, 1 jagah hai)
sudo ln -s /etc/nginx/sites-available/apnashift /etc/nginx/sites-enabled/apnashift  # site enable karo
sudo nginx -t                                                  # syntax check (reload se pehle — toota config live nahi hoga)
sudo systemctl reload nginx                                    # config live karo (connections nahi tootengi)
curl -s http://127.0.0.1:3000/api/health                       # app seedha jawab de raha? {"ok":true...} aana chahiye
curl -s http://api.example.com/api/health                      # nginx se hokar bhi aana chahiye (domain badlo)
```

Ab HTTPS (free, auto-renew):

```bash
sudo apt-get install -y certbot python3-certbot-nginx          # Let's Encrypt client + nginx plugin
sudo certbot --nginx -d api.example.com                        # cert banao + nginx me 443 block khud jodo (domain badlo)
sudo certbot renew --dry-run                                   # renewal test karo (fail ho to expiry par outage hoga)
systemctl list-timers | grep certbot                           # auto-renew timer active dikhe (Ubuntu me default on hai)
```

> Certbot 443 block khud likhta hai — `deploy/nginx-apnashift.conf` me haath se 443 mat jodo. Renew hone par nginx reload khud hota hai.

## 5. Firewall (ufw) + Oracle security list

```bash
sudo apt-get install -y ufw                  # firewall (shayad pehle se ho)
sudo ufw allow OpenSSH                       # ⚠️ SABSE PEHLE: SSH allow, warna lockout ho jaoge
sudo ufw allow 80/tcp                        # HTTP (Certbot challenge + redirect)
sudo ufw allow 443/tcp                       # HTTPS API traffic
sudo ufw default deny incoming               # baaki sab incoming block (3000/5432 bahar se band)
sudo ufw default allow outgoing              # update/certbot ke liye bahar jaane do
sudo ufw enable                              # firewall on karo (y/N puchega — SSH allow kar chuke ho, to y)
sudo ufw status numbered                     # verify: 22, 80, 443 ALLOW, baaki deny
```

**Oracle Cloud console (ye step browser me — ufw se alag, dono chahiye):**

1. OCI Console → instance → **Attached VNIC → Subnet** kholo (ya Networking → Security Lists).
2. Subnet ki **Security List** me **Add Ingress Rules** (stateful — return traffic auto-allowed):
   - `0.0.0.0/0`, TCP, port **80**, description `http`
   - `0.0.0.0/0`, TCP, port **443**, description `https`
   - (SSH 22 ka rule default me hota hai — chedna mat.)
3. Port **3000/5432 ke liye koi rule mat banao** — Node/DB sirf localhost par hain.
4. Terminal se verify: `curl -s https://api.example.com/api/health` (apne laptop se bhi).

> ⚠️ Oracle me **do layer** hain: security-list rule ke bina ufw allow bekaar hai, aur ufw deny ke saath security-list allow bekaar hai. 443 na khule to pehle security list, phir `sudo ufw status` dekho.

## 6. Daily backup (pg_dump, 7-day rotation)

```bash
sudo mkdir -p /var/backups/apnashift                        # backup folder (root-owned)
sudo chown ubuntu:ubuntu /var/backups/apnashift             # cron ubuntu user se chalega
chmod +x deploy/backup.sh deploy/smoke.sh                   # scripts executable banao
./deploy/backup.sh                                          # pehli baar haath se chalao (error abhi pakdo, raat ko nahi)
ls -lh /var/backups/apnashift/                              # .dump.gz dikhe + size > 0
crontab -e                                                  # cron kholo, ye line jodo:
```

```cron
0 2 * * * /opt/apnashift/apnashift-backend/deploy/backup.sh >> /var/log/apnashift-backup.log 2>&1
```
(cron line ka matlab: roz raat 2 baje backup, output log file me.)

```bash
sudo touch /var/log/apnashift-backup.log && sudo chown ubuntu:ubuntu /var/log/apnashift-backup.log  # log file banao
cat /var/log/apnashift-backup.log                           # agle din "ok:" line dikhe = rotation kaam kar raha
```

> ⚠️ **DESTRUCTIVE — restore sirf jab zaroori ho:** `pg_restore` `--clean` ke saath **live tables drop** karta hai. Hamesha pehle fresh backup lo, phir:
>
> ```bash
> ./deploy/backup.sh                                         # pehle current state bachao
> pg_restore --clean -d "$DATABASE_URL" /var/backups/apnashift/<file>.dump.gz  # purana data wapas (live data jayega!)
> ```
>
> Hafte me ek baar `.dump.gz` apne laptop par `scp` se download karo — server ke saath backup dooba to koi fayda nahi: `scp ubuntu@<server-ip>:/var/backups/apnashift/<file>.dump.gz .`

## 7. Safe update deploy (code badalne par)

```bash
cd /opt/apnashift/apnashift-backend              # app folder me jao
git status --short                               # ⚠️ pehle dekho: .env ya config me local change hai? (.env gitignored hai — pull se safe)
git pull --ff-only                               # naya code lao (fast-forward only — conflict ho to ruko, force mat karo)
npm ci --omit=dev                                # nayi deps exact install karo
npm run db:migrate                               # migrations (additive — purana data safe; ⚠️ pehle backup le lo, neeche dekho)
pm2 reload apnashift-api                         # zero-downtime restart (in-flight request 1-2s ruk sakti hai single instance par)
BASE_URL=http://127.0.0.1:3000 ./deploy/smoke.sh  # checklist green? tabhi aage badho
```

> ⚠️ Migrate se pehle agar bookings/ratings ka live data hai to `./deploy/backup.sh` chala lo — 10 second ka kaam hai. Kuch gadbad lage to `pm2 logs apnashift-api --lines 50` dekho, aur last resort: `git log --oneline -5` se pichla commit `git checkout <sha>` karke `pm2 reload` (rollback).

## 8. Smoke-test checklist (har deploy ke baad)

Haath se ya `BASE_URL=https://api.example.com ./deploy/smoke.sh` se (script kuch write nahi karta — prod DB safe):

| # | Command | Expected |
|---|---------|----------|
| 1 | `curl -s https://api.example.com/api/health` | `200`, `{"ok":true,...}` (nginx+cert OK) |
| 2 | `curl -s https://api.example.com/api/ready` | `200`, `{"db":"up"}` (Postgres reachable) |
| 3 | `POST /api/bookings/estimate-price` (script me sample body) | `200` + `total` (rates seed hue) |
| 4 | `GET https://api.example.com/api/invalid-route-xyz` | `404 not_found` (error shape sahi) |
| 5 | `pm2 status` | `apnashift-api` = `online`, restarts stable |
| 6 | `sudo nginx -t` | `syntax ok`, `test is successful` |
| 7 | `sudo certbot certificates` | expiry 60+ din (renew timer kaam kar raha) |
| 8 | `sudo ufw status` | sirf 22/80/443 ALLOW |

Fail ho to order: `pm2 logs apnashift-api --lines 50` → `sudo systemctl status postgresql nginx` → section 7 rollback.
