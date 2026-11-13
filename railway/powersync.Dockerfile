FROM journeyapps/powersync-service:1.26.0
COPY railway/service.yaml /config/service.yaml
COPY powersync/sync-config.yaml /config/sync-config.yaml
COPY railway/powersync-supervisor.mjs /app/powerbin-powersync.mjs
ENV POWERSYNC_CONFIG_PATH=/config/service.yaml
ENTRYPOINT ["node", "/app/powerbin-powersync.mjs"]
CMD ["start", "-r", "unified"]
