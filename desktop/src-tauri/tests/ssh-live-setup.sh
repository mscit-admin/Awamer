#!/bin/sh
# Start a throwaway OpenSSH server for the desktop SSH live tests
# (src/commands/ssh_live_test.rs). Test-only: loopback, random keys, a
# dedicated local user. Prints the env exports the test needs.
#   sudo sh tests/ssh-live-setup.sh /tmp/awamer-ssh-live 2222
set -eu
DIR="${1:?usage: ssh-live-setup.sh <dir> [port]}"; PORT="${2:-2222}"
USER_NAME=awamersshtest
PASS="live-$(openssl rand -hex 12)"
mkdir -p "$DIR" && chmod 755 "$DIR"
id "$USER_NAME" >/dev/null 2>&1 || useradd -m -s /bin/sh "$USER_NAME"
echo "$USER_NAME:$PASS" | chpasswd
rm -f "$DIR"/host_ed25519* && ssh-keygen -q -t ed25519 -N '' -f "$DIR/host_ed25519"
rm -f "$DIR"/user_* ; ssh-keygen -q -t ed25519 -N '' -f "$DIR/user_ed25519"
ssh-keygen -q -t rsa -b 3072 -N '' -f "$DIR/user_rsa"
ssh-keygen -q -t ed25519 -N 'correct-pass' -f "$DIR/user_enc"
H=$(getent passwd "$USER_NAME" | cut -d: -f6)
mkdir -p "$H/.ssh" && cat "$DIR"/user_*.pub > "$H/.ssh/authorized_keys"
chown -R "$USER_NAME" "$H/.ssh" && chmod 700 "$H/.ssh" && chmod 600 "$H/.ssh/authorized_keys"
cat > "$DIR/sshd_config" <<CFG
Port $PORT
ListenAddress 127.0.0.1
HostKey $DIR/host_ed25519
PidFile $DIR/sshd.pid
PasswordAuthentication yes
KbdInteractiveAuthentication no
PubkeyAuthentication yes
UsePAM yes
Subsystem sftp internal-sftp
CFG
mkdir -p /run/sshd
[ -f "$DIR/sshd.pid" ] && kill "$(cat "$DIR/sshd.pid")" 2>/dev/null || true
/usr/sbin/sshd -f "$DIR/sshd_config"
echo "export AWAMER_SSH_TEST_PORT=$PORT AWAMER_SSH_TEST_DIR=$DIR AWAMER_SSH_TEST_USER=$USER_NAME AWAMER_SSH_TEST_PASSWORD=$PASS"
