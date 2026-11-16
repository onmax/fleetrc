# Ubuntu 24.04 with systemd as PID 1 and Node 22, to see what doctor and timer say under systemd.
FROM sf-u2-ubuntu22
USER root
RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus dbus-user-session \
 && rm -rf /var/lib/apt/lists/* \
 && systemctl mask systemd-logind.service getty.target console-getty.service 2>/dev/null; systemctl unmask systemd-logind.service
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
