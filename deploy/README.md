# Preparing a VPS for FPVTP!

A **human** checklist, to be followed **once** on a fresh machine.
This is not a provisioning script: every step is typed by hand, in order, as
root. It is written for someone who does not know the project — nothing here is
left to be guessed.

**Become root before step 1, and stay there:**

```sh
sudo -i
```

Most providers hand you an unprivileged account — `ubuntu` on OVH, `debian` on
others — never root, so without this the very first commands fail with
`Permission denied` after appearing to work. Prefixing individual commands with
`sudo` also works, but note that `sudo` does not travel down a pipe: in
`curl … | gpg --dearmor -o /usr/share/keyrings/…` it is `gpg` that needs the
privilege, not `curl`, so it has to read `curl … | sudo gpg …`. Every step
below is written for a root shell.

After that, each new version ships in one command:
`sudo /opt/fpvtp/deploy.sh v1.0.0`.

The reference design lives in the repository, at
`sim/docs/superpowers/specs/2026-09-07-dual-mode-deployment-design.md`
(section "D4").

## What the machine runs

| what | where |
|---|---|
| the game server (Node) | `fpvtp.service`, listening on `127.0.0.1:8080` |
| the TLS front end | Caddy, `fpvtp.example.org` → port 8080 |
| the program | `/opt/fpvtp/releases/<tag>`, with `/opt/fpvtp/current` pointing at the active version |
| the data | `/var/lib/fpvtp` (never overwritten by an update) |
| *(optional)* a download page for the desktop installers | Caddy, `updates.fpvtp.example.org` → `/srv/fpvtp-updates` |
| *(optional)* a GitHub token | `/etc/fpvtp/token`, only to raise the API rate limit |

The two optional rows are optional in the strict sense: skip them and
everything else still works. See "The desktop installers" below for why the
download page is no longer required.

The server runs in **`shared` mode**. Two consequences worth knowing:

- it **never** acquires terrain. `FPVTP_ACQUIRE` is not set in the systemd unit
  and must never be: the VPS only serves LIVE flight, whose geometry and
  textures are downloaded by the player's browser, without going through this
  machine;
- it therefore stores no scene. `/var/lib/fpvtp/scenes` stays empty forever.

## Prerequisites

- A recent Debian or Ubuntu (the commands below are for `apt`).
- One DNS name pointing at the machine's IP, for example `fpvtp.example.org`.
  A second one (`updates.fpvtp.example.org`) only if you want the optional
  download page.
- Ports 80 and 443 open (Caddy needs them to obtain the certificates). Port
  8080 must stay **closed** to the outside.
- No GitHub token is required: the repository is public, so the Releases API
  answers without authentication. A read-only token is only worth setting if
  the anonymous rate limit (60 requests per hour and per IP) is a problem on
  this machine — see step 3.

Tools used by `deploy.sh`: `curl`, `jq`, `tar`, `unzip`, `systemctl`,
`install`. Install what is missing:

```sh
apt update
apt install -y curl jq tar unzip
```

## 1. The system user

An account with no shell and no home: it exists only to run the service.

```sh
adduser --system --group --no-create-home --shell /usr/sbin/nologin fpvtp
```

## 2. The directories

```sh
# The program. It belongs to root: the service reads it, it does not write it.
install -d -o root  -m 0755 /opt/fpvtp
install -d -o root  -m 0755 /opt/fpvtp/releases

# The data. This is the only place the service writes to.
install -d -o fpvtp -g fpvtp -m 0750 /var/lib/fpvtp

# Optional: the desktop installers, served publicly by Caddy. Skip this line
# if you are not standing up the download page (see below).
install -d -o root -m 0755 /srv/fpvtp-updates
```

Caddy's log directory is NOT here: the `caddy` user it must belong to does not
exist until the package is installed. It is the first command of step 4.

## 3. The GitHub token (optional)

The repository is public: `deploy.sh` downloads a Release without any
credentials, and this step can be skipped entirely. A token only raises the
GitHub API rate limit, which matters when the machine shares its IP with other
API callers — one delivery spends four or five requests against an anonymous
budget of 60 per hour. If the API answers `403`, that budget is what ran out.

A fine-grained token with "Contents: Read" is enough:

```sh
install -d -o root -g root -m 0700 /etc/fpvtp
printf '%s' 'github_pat_xxxxxxxxxxxx' > /etc/fpvtp/token
chmod 0600 /etc/fpvtp/token
chown root:root /etc/fpvtp/token
```

The file is read by `deploy.sh`, which runs as root: the `fpvtp` account has no
access to it, and that is intended.

## 4. Caddy

```sh
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy

# Now that the package has created the `caddy` user, its log directory. Do this
# BEFORE the first reload: the Caddyfile logs to /var/log/caddy/fpvtp.log, and a
# reload with the directory missing is refused with `setting up custom log
# 'log0'` — Caddy keeps the previous config and the service stays up, so the
# failure is easy to miss.
install -d -o caddy -g caddy -m 0750 /var/log/caddy
```

Then install this directory's configuration, replacing the `example.org`
occurrences with the real domain. If you are not standing up the optional
download page, delete the second block (`updates.`) rather than pointing it at
a name that does not resolve.

```sh
cp deploy/Caddyfile /etc/caddy/Caddyfile
$EDITOR /etc/caddy/Caddyfile          # the domain names
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

`caddy validate` must say `Valid configuration` before going any further.

## 5. The service

```sh
cp deploy/fpvtp.service /etc/systemd/system/fpvtp.service
systemctl daemon-reload
systemctl enable fpvtp        # at machine boot
```

Do not start it yet: `/opt/fpvtp/current` does not exist until a version has
been shipped. That is `deploy.sh`'s job.

## 6. The delivery script

```sh
cp deploy/deploy.sh /opt/fpvtp/deploy.sh
chmod 0755 /opt/fpvtp/deploy.sh
```

## 7. The first delivery

```sh
sudo /opt/fpvtp/deploy.sh v1.0.0
```

The script downloads the release, unpacks it, switches
`/opt/fpvtp/current`, restarts the service, checks that it answers, then — if
`/srv/fpvtp-updates` exists — mirrors the desktop installers into it.

At the moment it switches, it prints the path of the previous release: rolling
back is always

```sh
ln -sfn /opt/fpvtp/releases/<previous tag> /opt/fpvtp/current
systemctl restart fpvtp
```

Triggering stays **manual** for now: you run `deploy.sh` over SSH, by hand.
`.github/workflows/release.yml` builds and publishes, it does not deploy. An
automatic `deploy` step there (gated on `DEPLOY_HOST` / `DEPLOY_KEY` secrets)
will come **after** a first manual delivery has succeeded — not before.

## 8. Existing operators (optional)

To carry over sessions already played locally, copy their state:

```sh
rsync -a sim/operator-state/ root@vps:/var/lib/fpvtp/operator-state/
chown -R fpvtp:fpvtp /var/lib/fpvtp/operator-state
```

In `shared` mode, an operator with no key is unusable until one has been
generated — which is the case for every file created before operator keys
existed. From the program directory:

```sh
sudo -u fpvtp /opt/fpvtp/current/node/bin/node \
  /opt/fpvtp/current/app/server/index.mjs key <operatorId>
```

The key is shown **once**: pass it to the person concerned, who will type it on
the `OPERATOR KEY` screen. Running the command again issues a new one and
invalidates the previous. It is also the only recovery path when somebody loses
theirs: there is no password, no e-mail address, and no self-service reset.

---

## Hardening the machine

The service is already sandboxed hard — read `fpvtp.service`: no shell, no
home, `ProtectSystem=strict`, a syscall filter, and a listener bound to
127.0.0.1 so the only way in is through Caddy. The application is not where a
box like this gets taken. **SSH and an unpatched kernel are.** Everything below
is about the machine, not the game, and none of it is in the steps above.

Do this before the domain is public. A public link is port-scanned within the
hour, and every one of those scans tries SSH.

### SSH: keys only

Password authentication is the whole attack. Copy your key up, confirm it
works in a **second terminal you keep open**, and only then close the door —
locking yourself out of a fresh VPS is a rebuild, not an inconvenience.

```sh
ssh-copy-id root@<origin-ip>      # from your machine
```

Then, on the server, in `/etc/ssh/sshd_config.d/99-hardening.conf`:

```
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
```

`sshd -t && systemctl reload ssh`. Test from the still-open second terminal
before you trust it.

`PermitRootLogin prohibit-password` rather than `no` keeps this simple: the
delivery script runs as root anyway. If you would rather have a named sudo
user, create it and set `no` — both are defensible; what is not defensible is
leaving passwords on.

### Restrict who may even reach port 22

The `ufw` rules above open 22 to the internet. If your home address is static,
narrow it and the scanning stops mattering:

```sh
ufw delete allow 22/tcp
ufw allow from <your-ip> to any port 22 proto tcp
```

If it is not static — most consumer connections are not — leave it open and
install `fail2ban`, which bans an address after a handful of failures:

```sh
apt install -y fail2ban
systemctl enable --now fail2ban
fail2ban-client status sshd
```

Its defaults are sane for SSH. This is a mitigation, not a fix: with password
authentication off, a brute force cannot succeed anyway. It mostly keeps the
logs readable.

### Automatic security updates

The single highest-value line here, because it is the one that keeps working
after you stop paying attention:

```sh
apt install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades
```

Confirm it is actually enabled — the package being installed is not the same
as the timer running:

```sh
systemctl status unattended-upgrades
grep -r "Unattended-Upgrade" /etc/apt/apt.conf.d/20auto-upgrades
```

Node is not in that stream: the runtime travels inside the release archive, so
a Node security fix reaches this machine through a new release of the game, not
through `apt`. That is deliberate — see "The Node runtime" — but it means you
have to actually ship one.

### Cloudflare, if you are behind it

Set SSL/TLS mode to **Full (strict)**. Caddy holds a real Let's Encrypt
certificate, so strict validation works and nothing breaks; anything weaker
lets the leg between Cloudflare and your origin be intercepted, which is the
whole thing you were trying to protect. Check it rather than assume it.

Worth turning on while you are there: Bot Fight Mode, and a rate-limiting rule
on `/__operator/*`. The server's own signup limit is five per hour per address,
which is the right shape but is enforced after the request reaches Node.

### What to watch on the day

```sh
journalctl -u fpvtp -f            # the game
journalctl -u caddy -f            # TLS, and every request that reaches you
fail2ban-client status sshd       # who is knocking
```

The game's log names operator ids. They are not credentials — the key is
hashed on disk and shown once — but they are user-chosen names, so treat a log
paste the way you would treat any other user data before putting it in a public
issue.

## Behind Cloudflare (optional, and all-or-nothing)

Proxying the domain through Cloudflare — the orange cloud — is the cheapest way
to survive a busy day: the bundle and the music are static and immutable, so the
edge serves them and the origin barely works. It is also the one change that can
silently break the signup limit, so the three steps below go together or not at
all.

**What breaks if you do it halfway.** With the proxy on, Caddy's peer is
Cloudflare, not the visitor. The server identifies a client by the last hop of
`X-Forwarded-For`, so every visitor on earth becomes one address, and the limit
of five signups per hour becomes five for the whole internet. The sixth person
of the hour is refused.

**1. Stop discarding the real address.** Delete the `request_header
-X-Forwarded-For` line from the game block in `Caddyfile`. It exists to throw
away what the client claimed; with Cloudflare in front, what arrives is what
Cloudflare observed, and it is the only copy of the visitor's address you get.

**2. Firewall the origin to Cloudflare, first.** Do this before step 3, not
after. While the origin answers anyone, `CF-Connecting-IP` is just a header the
caller typed, and a caller who picks their own value picks their own rate-limit
key — the exact hole the limit exists to close.

```sh
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
for ip in $(curl -fsS https://www.cloudflare.com/ips-v4) $(curl -fsS https://www.cloudflare.com/ips-v6); do
        ufw allow from "$ip" to any port 80,443 proto tcp
done
ufw --force enable
ufw status numbered
```

Check from your own machine that the origin IP is now unreachable while the
domain still works:

```sh
curl -m 5 https://<origin-ip>/            # must time out
curl -sI https://fpvtp.example.org/       # must answer
```

Cloudflare's ranges change rarely, but they do change. Re-run the loop after any
change, or leave a monthly cron doing it.

**3. Only then, tell the server.** Uncomment `Environment=FPVTP_TRUST_CF_IP=1`
in `fpvtp.service`, then `systemctl daemon-reload && systemctl restart fpvtp`.

**4. Prove it worked.** Sign up from a phone on mobile data, then from your
desktop, and confirm both succeed — two different addresses, two separate
budgets. If the second is refused as "too many signups", the server is still
counting everyone as one client and something above is wrong.

**Caching.** Cloudflare caches by extension out of the box, which already covers
the bundle and the `.opus` tracks. Do not cache `/__map-api/*` or
`/__operator/*`: they are per-operator and authenticated. A cache rule that
bypasses anything starting with `/__` is the safe shape.

## The Node runtime, and the shape of the archive

`fpvtp.service` runs `/opt/fpvtp/current/node/bin/node` with
`/opt/fpvtp/current/app` as its working directory. The `linux-x64` asset
`deploy.sh` expects therefore has this shape:

```
<archive>/
  app/          server/ tools/ src/ dist/ package.json
  node/bin/node
  deploy/       this directory
  LICENSE
```

**This is what `.github/workflows/release.yml` produces**: the "Server archive,
for self-hosting" step copies `server/ tools/ src/ dist/ package.json` into
`app/`, downloads the official tarball of the very Node version that just
passed the selftests, and publishes the whole thing as
`fpvtp-server-<tag>-linux-x64.tar.gz`.

**No `npm install` on the VPS, and that is deliberate**: the server needs no
npm dependency at all to start — measured on 2026-09-07 on an archive built
exactly like the CI one, **without `node_modules`**:

```
FPVTP! v1.0.0 — mode shared — acquisition closed — data … — http://127.0.0.1:8299/
GET /                       → 200 text/html
GET /__map-api/scenes       → 401   (operator key required, shared mode)
GET /__operator             → 404   (no public directory in shared)
POST /__map-api/jobs        → 401
```

So the archive does NOT contain `node_modules`. The native modules (`sharp`,
Rapier) only serve terrain acquisition, which is closed on the VPS.

A note on the health check: the `401` above is the NORMAL answer of
`/__map-api/scenes` in `shared` mode once operator keys are in place.
`deploy.sh` accepts 200, 401 and 403 — what it verifies is that Node answers,
not that it opens the door.

A note on what `shared` additionally refuses: `DELETE /__map-api/scenes/:slug`
and `DELETE /__map-api/jobs/:id` return `403`, valid operator key or not.
Sign-up is open and there is neither a role nor an owner: without that refusal,
any registered player could erase a terrain for the whole instance, with no way
to rebuild it (acquisition is closed in `shared`). A scene is therefore only
removed from the machine's shell.

A possible variant, if you prefer: install Node on the machine (`apt` or
NodeSource) and change `ExecStart` to `/usr/bin/node`. This directory follows
the shape described by the design (embedded runtime), because it makes the Node
version travel with the game version — but the choice stays open.

## The desktop installers

The Windows and Linux installers are attached to each GitHub Release, together
with the `latest.yml` / `latest-linux.yml` feed files. **That is where
electron-updater reads them from**: `sim/electron-builder.yml` uses
`provider: github`, so an installed app updates itself straight from the
Releases API, with no server of yours involved.

The `updates.fpvtp.example.org` block of the `Caddyfile` and the
`/srv/fpvtp-updates` directory are therefore **optional**. They are worth
standing up in two cases:

- you want a download page under your own domain, instead of sending people to
  GitHub;
- you distribute a fork or a private build and want your own update feed. Point
  the app at it with the `FPVTP_UPDATE_URL` environment variable, which
  overrides the baked feed at runtime, without rebuilding.

The last step of `deploy.sh` fills that directory from the Release assets, and
skips it with a warning when it does not exist. It never fails the delivery of
the server.

## Backups

There is a single thing to back up: `/var/lib/fpvtp/operator-state`. It is
small (on the order of 174 KB per operator without the screenshots, a few MB
with them). A daily `tar` is plenty — for instance in
`/etc/cron.daily/fpvtp-backup`:

```sh
#!/bin/sh
set -eu
dest=/var/backups/fpvtp
mkdir -p "$dest"
tar -czf "$dest/operator-state-$(date +%F).tar.gz" -C /var/lib/fpvtp operator-state
find "$dest" -name 'operator-state-*.tar.gz' -mtime +30 -delete
```

Nothing else needs backing up:

- `/opt/fpvtp` is rebuilt by `deploy.sh` from a GitHub release;
- **no scene is ever written on the VPS** (acquisition is closed there, see
  above), so `/var/lib/fpvtp/scenes` stays empty and there is no particular
  disk-space monitoring to set up;
- the weather cache (`/var/lib/fpvtp/…`) rebuilds itself.

## Checking that it runs

```sh
systemctl status fpvtp
journalctl -u fpvtp -f
curl -s localhost:8080/__map-api/scenes        # must answer JSON
curl -sI https://fpvtp.example.org/            # must answer over HTTPS
curl -s  https://updates.fpvtp.example.org/latest-linux.yml   # optional block only
```

On start-up, the server writes one line that says everything:

```
FPVTP! v1.0.0 — mode shared — acquisition closed — data /var/lib/fpvtp — http://127.0.0.1:8080/
```

If `mode` does not say `shared` there, or if the data directory is not
`/var/lib/fpvtp`, the systemd unit was not picked up: run `systemctl
daemon-reload` then `systemctl restart fpvtp`.

## What could not be verified

These files were written without access to a VPS. What was actually measured:
the syntax of `deploy.sh` (`bash -n`), the validity of the `fpvtp.service`
directives (`systemd-analyze verify`), and the fact that `sim/server/index.mjs`
does read `FPVTP_MODE`, `FPVTP_DATA_DIR`, `FPVTP_HOST` and `FPVTP_PORT` (server
started in `shared` mode with those variables, answering `200 {"scenes":[]}` on
`/__map-api/scenes`).

Measured afterwards: an archive built exactly like the CI one (`app/` +
`node/`, **without `node_modules`**) starts in `shared` mode and serves the
game — see the "The Node runtime" section above for the response codes
recorded.

What has **not** been verified, and will be at the first real delivery: the
`Caddyfile` (Caddy was not installed, `caddy validate` could not be run), the
systemd hardening under real load, `electron-updater` against the GitHub
Releases feed, and the whole end-to-end path. `release.yml` itself has never
run on a runner.
