# /setup em producao - protecoes de rede via nginx

A endpoint `/setup` ja vem com:

1. **Bootstrap token** (32 hex chars, file mode 0o600) - exigido em query.
2. **CSRF token** (cookie `maia_setup_csrf` sameSite=strict + hidden input no form).
3. **Rate limit** (30 req/min/IP em `/setup*`, com `/setup/status` isento -
   ele e pollado pela pagina a cada 2s e ocuparia o orcamento sozinho).
4. **Security headers** (`Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`).

Pra producao, adicione duas camadas extras no nginx:

## 1. IP whitelist

Mesmo que o token vaze, sem o IP correto nao passa.

```nginx
location /setup {
    allow 203.0.113.42;       # casa
    allow 198.51.100.0/24;    # VPN
    deny all;

    proxy_pass http://localhost:3000;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

> Use `location ^~ /setup` se houver outras rotas comecando com `/setup`.

## 2. Basic auth (opcional, defesa em profundidade)

```bash
sudo apt-get install apache2-utils
sudo htpasswd -c /etc/nginx/maia-setup.htpasswd operator
```

```nginx
location /setup {
    allow 203.0.113.42;
    deny all;

    auth_basic           "Maia Setup";
    auth_basic_user_file /etc/nginx/maia-setup.htpasswd;

    proxy_pass http://localhost:3000;
    # ... mesmos proxy_set_header acima ...
}
```

## 3. TLS termination (obrigatorio)

`/setup` envia o token na URL. **TLS e obrigatorio em producao.**

```bash
sudo apt-get install certbot python3-certbot-nginx
sudo certbot --nginx -d maia.seu-dominio.com
```

O cookie CSRF e `httpOnly + sameSite=strict` em qualquer ambiente. A flag
`secure` e decidida no codigo a partir de `NODE_ENV`: vira `true` quando
`NODE_ENV=production`, `false` em dev/test. Garanta no systemd / .env do
servidor:

```ini
NODE_ENV=production
```

Sem isso o navegador aceita o cookie via HTTP (cleartext) e a defesa cai.
Confira no primeiro GET pos-deploy:

```bash
curl -is "https://maia.seu-dominio.com/setup?token=$TOKEN" | grep -i set-cookie
# Esperado: Set-Cookie: maia_setup_csrf=...; HttpOnly; Secure; SameSite=Strict
```

## 4. fail2ban (opcional)

Banir IP apos 5 tentativas com 403 em 10min:

```ini
# /etc/fail2ban/jail.d/maia-setup.conf
[maia-setup]
enabled  = true
filter   = maia-setup
logpath  = /var/log/nginx/access.log
maxretry = 5
findtime = 600
bantime  = 3600
```

```ini
# /etc/fail2ban/filter.d/maia-setup.conf
[Definition]
failregex = ^<HOST> .* "POST /setup/start.*" 403
            ^<HOST> .* "GET /setup\?token=.*" 403
ignoreregex =
```

`403` cobre tanto token invalido quanto CSRF mismatch.

## Verificacao rapida

Do **outro IP** (nao whitelisted):

```bash
curl -i https://maia.seu-dominio.com/setup
# Esperado: 403 Forbidden (do nginx, antes mesmo de bater no Maia)
```

Do IP do operador:

```bash
TOKEN=$(ssh maia 'cat .baileys-auth/setup-token.txt')
curl -i "https://maia.seu-dominio.com/setup?token=$TOKEN"
# Esperado: 200 OK + Set-Cookie: maia_setup_csrf=...
```
