# A fleet host: sshd with key-only auth, node and git. The `fleet` user's key comes in at run time.
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server git ca-certificates \
 && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd \
 && useradd -m -s /bin/bash fleet && usermod -p "*" fleet && mkdir -p /home/fleet/.ssh && chown fleet /home/fleet/.ssh && chmod 700 /home/fleet/.ssh \
 && printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nPubkeyAuthentication yes\nUsePAM no\n' >/etc/ssh/sshd_config.d/key-only.conf \
 && ssh-keygen -A
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
