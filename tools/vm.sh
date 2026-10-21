#!/bin/bash
# Helper script for the Reiter test VM (GNOME Boxes / libvirt session on the desktop, SSH over vsock).
# vm.sh run '<command>'    run a command in the VM (user reiter)
# vm.sh deploy             copy the extension from the repo into the VM and enable it
# vm.sh relogin            restart GDM (autologin = fresh shell), waits until the shell is running
# vm.sh key KEY_LEFTMETA KEY_G   send keys to the VM
# vm.sh shot <name>        screenshot to ~/.claude/jobs/*/tmp/<name>.png (for reading)
# vm.sh drag X1 Y1 X2 Y2   drag with the button held
# vm.sh click X Y          mouse click (pixels of the screenshot size, VW/VH) via QMP
# vm.sh app <command>      start a program in the VM session (Wayland)
set -euo pipefail
CID=3
T=${REITER_TMP:-/tmp/reiter-vm}; mkdir -p "$T"
HOST=${VM_HOST:-desktop}   # SSH alias of the machine running the VM
VMDIR=${VM_DIR:-vm}        # directory there for screenshots
VIRSH="virsh -c qemu:///session"
vmssh() { ssh "$HOST" "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new reiter@vsock/$CID $(printf '%q' "$1")"; }
case "${1:-}" in
  run) vmssh "$2" ;;
  deploy)
    tar c -C "$(dirname "$0")/.." reiter@hoever.cc | ssh "$HOST" "ssh -o BatchMode=yes reiter@vsock/$CID 'rm -rf ~/.local/share/gnome-shell/extensions/reiter@hoever.cc; mkdir -p ~/.local/share/gnome-shell/extensions; tar x -C ~/.local/share/gnome-shell/extensions && glib-compile-schemas ~/.local/share/gnome-shell/extensions/reiter@hoever.cc/schemas'"
    vmssh 'export XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus; gsettings set org.gnome.shell enabled-extensions "[\"reiter@hoever.cc\"]"; gsettings set org.gnome.desktop.session idle-delay 0; gsettings set org.gnome.desktop.screensaver lock-enabled false; gsettings set org.gnome.desktop.interface enable-animations false' ;;
  relogin)
    vmssh 'sudo systemctl restart gdm3' || true
    sleep 12
    for i in $(seq 1 30); do
      vmssh 'pgrep -x gnome-shell >/dev/null' 2>/dev/null && break; sleep 3
    done
    sleep 6 ;;
  key) shift; ssh "$HOST" "$VIRSH send-key reiter-vm --codeset linux $*" ;;
  shot)
    ssh "$HOST" "$VIRSH screenshot reiter-vm $VMDIR/s.ppm >/dev/null && python3 -c 'from PIL import Image; Image.open(\"$VMDIR/s.ppm\").save(\"$VMDIR/s.png\")'"
    scp -q "$HOST:$VMDIR/s.png" "$T/${2:-shot}.png"; echo "$T/${2:-shot}.png" ;;
  move)
    X=$(( $2 * 32767 / ${VW:-1155} )); Y=$(( $3 * 32767 / ${VH:-999} ))
    ssh "$HOST" "$VIRSH qemu-monitor-command reiter-vm '{\"execute\":\"input-send-event\",\"arguments\":{\"events\":[{\"type\":\"abs\",\"data\":{\"axis\":\"x\",\"value\":$X}},{\"type\":\"abs\",\"data\":{\"axis\":\"y\",\"value\":$Y}}]}}' >/dev/null"; sleep 0.4 ;;
  click)
    X=$(( $2 * 32767 / ${VW:-1155} )); Y=$(( $3 * 32767 / ${VH:-999} ))
    # Warm-up: the shell drops the first pointer motion after login
    "$0" move 10 10; "$0" move "$2" "$3"
    ssh "$HOST" "$VIRSH qemu-monitor-command reiter-vm '{\"execute\":\"input-send-event\",\"arguments\":{\"events\":[{\"type\":\"abs\",\"data\":{\"axis\":\"x\",\"value\":$X}},{\"type\":\"abs\",\"data\":{\"axis\":\"y\",\"value\":$Y}}]}}' >/dev/null; sleep 0.3; $VIRSH qemu-monitor-command reiter-vm '{\"execute\":\"input-send-event\",\"arguments\":{\"events\":[{\"type\":\"btn\",\"data\":{\"down\":true,\"button\":\"${BTN:-left}\"}}]}}' >/dev/null; sleep 0.1; $VIRSH qemu-monitor-command reiter-vm '{\"execute\":\"input-send-event\",\"arguments\":{\"events\":[{\"type\":\"btn\",\"data\":{\"down\":false,\"button\":\"${BTN:-left}\"}}]}}' >/dev/null" ;;
  dclick)
    # dclick X Y: double click (four button events in one SSH session)
    "$0" move 10 10; "$0" move "$2" "$3"
    ssh "$HOST" "for s in true false true false; do $VIRSH qemu-monitor-command reiter-vm '{\"execute\":\"input-send-event\",\"arguments\":{\"events\":[{\"type\":\"btn\",\"data\":{\"down\":'\$s',\"button\":\"left\"}}]}}' >/dev/null; sleep 0.05; done" ;;
  drag)
    # drag X1 Y1 X2 Y2: button down, move in steps, release
    "$0" move 10 10; "$0" move "$2" "$3"
    ssh "$HOST" "$VIRSH qemu-monitor-command reiter-vm '{\"execute\":\"input-send-event\",\"arguments\":{\"events\":[{\"type\":\"btn\",\"data\":{\"down\":true,\"button\":\"left\"}}]}}' >/dev/null"
    for i in 1 2 3 4 5 6; do
      "$0" move $(( $2 + ($4 - $2) * i / 6 )) $(( $3 + ($5 - $3) * i / 6 ))
    done
    ssh "$HOST" "$VIRSH qemu-monitor-command reiter-vm '{\"execute\":\"input-send-event\",\"arguments\":{\"events\":[{\"type\":\"btn\",\"data\":{\"down\":false,\"button\":\"left\"}}]}}' >/dev/null" ;;
  app) vmssh "export XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus; nohup $2 >/dev/null 2>&1 &" ;;
  *) sed -n 2,9p "$0"; exit 1 ;;
esac
