FROM journeyapps/powersync-service:latest
COPY railway/service.yaml /config/service.yaml
COPY powersync/sync-config.yaml /config/sync-config.yaml
ENV POWERSYNC_CONFIG_PATH=/config/service.yaml
CMD ["start", "-r", "unified"]
