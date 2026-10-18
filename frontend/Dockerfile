FROM nginx:1.28-alpine
COPY index.html style.css app.js /usr/share/nginx/html/
COPY assets /usr/share/nginx/html/assets
COPY nginx.conf /etc/nginx/conf.d/default.conf
