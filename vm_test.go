package main

import (
	"strings"
	"testing"
)

// Командная строка QEMU, запущенного службой systemd (Windows-гость, slirp
// с пробросом RDP, VNC и QMP на unix-сокетах).
var win10Args = strings.Split(`/usr/bin/qemu-system-x86_64
-name
win10,debug-threads=on
-uuid
4E453CB0-0000-4000-8000-000000000001
-nodefaults
-machine
q35,accel=kvm,mem-merge=off
-cpu
host,topoext=on,hv_relaxed,hv_vapic,hv_time
-smp
12,sockets=1,cores=6,threads=2
-m
10G
-drive
if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.fd
-drive
if=pflash,format=raw,file=/srv/vm/win10/OVMF_VARS_4M.fd
-device
ahci,id=ahci
-drive
file=/srv/vm/win10/system.qcow2,if=none,id=disk0,format=qcow2,cache=none,aio=native,discard=unmap
-device
ide-hd,drive=disk0,bus=ahci.0,bootindex=1
-drive
file=/data/vm/win10/data.qcow2,if=none,id=disk1,format=qcow2
-netdev
user,id=net0,hostfwd=tcp:100.64.0.10:3389-:3389,hostfwd=tcp:127.0.0.1:2222-:22
-device
e1000e,netdev=net0,mac=52:54:00:12:34:56
-device
usb-tablet
-object
secret,id=vncpw,file=/etc/win10-vm/vnc.pass,format=raw
-vnc
unix:/run/win10-vm/vnc.sock,password-secret=vncpw
-qmp
unix:/run/win10-vm/qmp.sock,server=on,wait=off`, "\n")

func TestParseQEMU(t *testing.T) {
	v := parseQEMU(win10Args)
	if v.Name != "win10" || v.UUID != "4e453cb0-0000-4000-8000-000000000001" {
		t.Fatalf("name/uuid: %q %q", v.Name, v.UUID)
	}
	if v.CPUs != 12 || v.MemMB != 10240 || v.Accel != "kvm" || v.Machine != "q35" || v.Guest != "windows" {
		t.Fatalf("cpu/mem: %+v", v)
	}
	if len(v.Disks) != 2 || v.Disks[0].File != "/srv/vm/win10/system.qcow2" || v.Disks[1].Format != "qcow2" {
		t.Fatalf("disks: %+v", v.Disks)
	}
	if len(v.Nets) != 1 || v.Nets[0].Mode != "user" || v.Nets[0].MAC != "52:54:00:12:34:56" || v.Nets[0].Model != "e1000e" {
		t.Fatalf("nets: %+v", v.Nets)
	}
	if len(v.Fwds) != 2 || v.Fwds[0] != (VMFwd{Proto: "tcp", HostAddr: "100.64.0.10", HostPort: 3389, GuestPort: 3389}) || v.Fwds[1].HostPort != 2222 {
		t.Fatalf("fwds: %+v", v.Fwds)
	}
	if v.Display == nil || v.Display.Socket != "/run/win10-vm/vnc.sock" || !v.Display.Pass || v.Display.PassAt != "/etc/win10-vm/vnc.pass" {
		t.Fatalf("vnc: %+v", v.Display)
	}
	if v.qmp != "/run/win10-vm/qmp.sock" {
		t.Fatalf("qmp: %q", v.qmp)
	}

	c := vmConnect(v, Server{Alias: "box", Host: "203.0.113.5"})
	if len(c) != 3 {
		t.Fatalf("connect: %+v", c)
	}
	if c[0].Kind != "rdp" || c[0].Addr != "100.64.0.10:3389" || c[0].Pre != "" || c[0].URL != "rdp://full%20address=s:100.64.0.10" {
		t.Fatalf("rdp: %+v", c[0])
	}
	if c[1].Kind != "ssh" || c[1].Pre != "ssh -N -L 13389:127.0.0.1:2222 box" || c[1].Cmds[0] != "ssh -p 13389 localhost" {
		t.Fatalf("ssh: %+v", c[1])
	}
	if c[2].Kind != "vnc" || c[2].Pre != "ssh -N -L 5901:/run/win10-vm/vnc.sock box" || c[2].URL != "vnc://localhost:5901" {
		t.Fatalf("vnc: %+v", c[2])
	}
}

func TestParseQEMUVariants(t *testing.T) {
	// libvirt: guest=…, blockdev в JSON, tap и VNC на localhost
	v := parseQEMU([]string{"/usr/bin/qemu-system-x86_64", "-name", "guest=web1,debug-threads=on", "-S",
		"-blockdev", `{"driver":"file","filename":"/var/lib/libvirt/images/web1.qcow2","node-name":"libvirt-1-storage"}`,
		"-m", "size=4194304k", "-smp", "4,sockets=4,cores=1,threads=1",
		"-netdev", `tap,fd=30,id=hostnet0`, "-device", "virtio-net-pci,netdev=hostnet0,id=net0,mac=52:54:00:aa:bb:cc",
		"-vnc", "127.0.0.1:0", "-enable-kvm"})
	if v.Name != "web1" || v.MemMB != 4096 || v.CPUs != 4 || v.Accel != "kvm" {
		t.Fatalf("%+v", v)
	}
	if len(v.Disks) != 1 || v.Disks[0].File != "/var/lib/libvirt/images/web1.qcow2" {
		t.Fatalf("disks: %+v", v.Disks)
	}
	if len(v.Nets) != 1 || v.Nets[0].Mode != "tap" || v.Nets[0].MAC != "52:54:00:aa:bb:cc" {
		t.Fatalf("nets: %+v", v.Nets)
	}
	if v.Display == nil || v.Display.Port != 5900 || v.Display.Addr != "127.0.0.1" {
		t.Fatalf("vnc: %+v", v.Display)
	}
	v.Nets[0].IPs = []string{"192.168.122.10"}
	_ = vmConnect(v, Server{Host: "203.0.113.5", User: "root", Port: 2200})
	v.State = "running"
	c := vmConnect(v, Server{Host: "203.0.113.5", User: "root", Port: 2200})
	if len(c) != 2 || c[0].Cmds[0] != "ssh -J root@203.0.113.5:2200 192.168.122.10" || c[1].Pre != "ssh -N -L 5901:127.0.0.1:5900 -p 2200 root@203.0.113.5" {
		t.Fatalf("connect: %+v", c)
	}

	// Proxmox: -id, QMP через chardev + mon
	p := parseQEMU([]string{"/usr/bin/kvm", "-id", "101", "-name", "db,debug-threads=on", "-chardev", "socket,id=qmp,path=/var/run/qemu-server/101.qmp,server=on,wait=off", "-mon", "chardev=qmp,mode=control", "-m", "2048"})
	if p.pveID != "101" || p.qmp != "/var/run/qemu-server/101.qmp" || p.MemMB != 2048 {
		t.Fatalf("pve: %+v", p)
	}
}

func TestParseScans(t *testing.T) {
	out := "@@TICK 100\n@@UP 1000.00\n@@Q 77\nCG=/system.slice/win10-vm.service\nET=3600\nST=5000\nRSS=1048576\n"
	for _, a := range win10Args {
		out += "A " + a + "\n"
	}
	out += "@@CAND win10-vm.service\n@@CAND old-vm.service\n@@END\n"
	r := parseScan1(out)
	if len(r.vms) != 1 || r.vms[0].Unit != "win10-vm.service" || r.vms[0].Up != 3600 || r.vms[0].RSS != 1<<30 || r.vms[0].st1 != 5000 {
		t.Fatalf("scan1: %+v", r.vms)
	}
	if len(r.cands) != 2 {
		t.Fatalf("cands: %v", r.cands)
	}

	out2 := `@@UP 1001.00
@@ST 77 5600
@@UNIT win10-vm.service
ActiveState=active
SubState=running
UnitFileState=enabled
ExecStop={ path=/usr/local/libexec/win10-vm/qmp ; argv[]=/usr/local/libexec/win10-vm/qmp powerdown 170 ; ignore_errors=no }
MemoryMax=11811160064
CPUQuotaPerSecUSec=12s
@@UNIT old-vm.service
ActiveState=inactive
SubState=dead
ExecStop=
MemoryMax=infinity
@@QMP {"sock": "/run/win10-vm/qmp.sock", "status": "running", "usernet": "Hub -1 (net0):\n  Protocol[State]    FD  Source Address  Port   Dest. Address  Port RecvQ SendQ\n  TCP[ESTABLISHED]   50       10.0.2.15 64871 192.0.2.1  5228     0     0\n  TCP[HOST_FORWARD]  16   100.64.0.10  3389       10.0.2.15  3389     0     0\n", "vnc": 1}
@@IMG /srv/vm/win10/system.qcow2
{"virtual-size": 193273528320, "actual-size": 40000000000, "format": "qcow2"}
@@NEIGH
192.168.122.10 dev virbr0 lladdr 52:54:00:aa:bb:cc REACHABLE
192.168.122.11 dev virbr0 FAILED
@@EST
3389 1
@@END
`
	r2 := parseScan2(out2)
	u := r2.units["win10-vm.service"]
	if u == nil || !u.execStop || u.lim.CPU != 12 || u.lim.Mem != 11811160064 || u.enabled != "enabled" {
		t.Fatalf("unit: %+v", u)
	}
	if o := r2.units["old-vm.service"]; o == nil || o.execStop || o.lim.Mem != 0 || unitVMState(o) != "stopped" {
		t.Fatalf("old unit: %+v", o)
	}
	if q := r2.qmp["/run/win10-vm/qmp.sock"]; q == nil || q["status"] != "running" {
		t.Fatalf("qmp: %+v", r2.qmp)
	}
	ip, n := parseUsernet(r2.qmp["/run/win10-vm/qmp.sock"]["usernet"].(string))
	if ip != "10.0.2.15" || n != 1 {
		t.Fatalf("usernet: %q %d", ip, n)
	}
	if r2.imgs["/srv/vm/win10/system.qcow2"][0] != 193273528320 {
		t.Fatalf("img: %+v", r2.imgs)
	}
	if got := r2.neigh["52:54:00:aa:bb:cc"]; len(got) != 1 || got[0] != "192.168.122.10" {
		t.Fatalf("neigh: %+v", r2.neigh)
	}
	if r2.est[3389] != 1 || r2.up2 != 1001 || r2.st2[77] != 5600 {
		t.Fatalf("est/up/st: %+v %v %v", r2.est, r2.up2, r2.st2)
	}
}

func TestDominfoAndPVE(t *testing.T) {
	v := &VM{}
	for _, l := range strings.Split("Id:             1\nName:           web1\nUUID:           AAAA-BB\nState:          shut off\nCPU(s):         4\nMax memory:     4194304 KiB\nAutostart:      enable", "\n") {
		parseDominfo(v, l)
	}
	if v.UUID != "aaaa-bb" || v.State != "stopped" || v.CPUs != 4 || v.MemMB != 4096 || v.Autostart != "enabled" {
		t.Fatalf("dominfo: %+v", v)
	}
	p := &VM{}
	for _, l := range strings.Split("status: running\nname: db\ncores: 2\nsockets: 2\nmemory: 4096\nonboot: 1\nostype: win11\nnet0: virtio=BC:24:11:00:00:01,bridge=vmbr0,firewall=1", "\n") {
		parsePVE(p, l)
	}
	if p.State != "running" || p.Name != "db" || p.CPUs != 4 || p.MemMB != 4096 || p.Guest != "windows" || len(p.Nets) != 1 || p.Nets[0].MAC != "bc:24:11:00:00:01" || p.Nets[0].Bridge != "vmbr0" {
		t.Fatalf("pve: %+v", p)
	}
}

func TestVMAlarming(t *testing.T) {
	cases := []struct {
		v    VM
		want bool
	}{
		{VM{State: "running"}, false},
		{VM{State: "stopped"}, false},                        // ни разу не видели работающей
		{VM{State: "stopped", Ran: true}, true},              // работала и перестала сама
		{VM{State: "stopped", Ran: true, Stopped: 1}, false}, // остановили из панели
		{VM{State: "failed"}, true},
		{VM{State: "paused", Ran: true}, true},
		{VM{State: "starting", Ran: true}, false},
	}
	for i, c := range cases {
		if got := vmAlarming(&c.v); got != c.want {
			t.Errorf("%d %+v: %v", i, c.v, got)
		}
	}
}
