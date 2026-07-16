# Weekly public database backup sidecar.
#
# Built on the SAME postgres major as the database (16) so pg_dump/psql match
# the server version exactly — a client older than the server refuses to dump.
# The image ships the pg client tools already; we only add zip. It runs as root
# (not the image's default postgres user) so it can always write the bind-
# mounted /backups directory regardless of the host directory's ownership; the
# tools it runs are plain read-only clients, so this is a client-only container.
FROM postgres:16-alpine

RUN apk add --no-cache zip

COPY backup.sh entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/entrypoint.sh

ENV OUT_DIR=/backups
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
