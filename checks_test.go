package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"strings"
	"testing"
	"time"
)

func TestParseCheckTarget(t *testing.T) {
	ok := map[string]string{
		"https://Example.com":        "https://example.com/",
		"example.com":                "https://example.com/",
		"example.com/health":         "https://example.com/health",
		"http://10.0.0.1:8080/x#y":   "http://10.0.0.1:8080/x",
		"example.com:443":            "example.com:443",
		"tcp://1.2.3.4:22":           "1.2.3.4:22",
		"tls://mail.example.com:993": "tls://mail.example.com:993",
		"[2001:db8::1]:443":          "[2001:db8::1]:443",
	}
	for in, want := range ok {
		got, err := parseCheckTarget(in)
		if err != nil || got.canon() != want {
			t.Errorf("%q → %q, %v; want %q", in, got.canon(), err, want)
		}
	}
	for _, in := range []string{"", "ftp://x", "example.com:0", "example.com:99999", "https://user:pw@example.com", "a b:1", "tls://example.com", "ex ample.com"} {
		if _, err := parseCheckTarget(in); err == nil {
			t.Errorf("%q: ожидалась ошибка", in)
		}
	}
}

func TestCertCheck(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	mk := func(cn string, nb, na time.Time, dns ...string) *x509.Certificate {
		tpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: cn}, NotBefore: nb, NotAfter: na, DNSNames: dns}
		der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
		if err != nil {
			t.Fatal(err)
		}
		c, _ := x509.ParseCertificate(der)
		return c
	}
	now := time.Now()
	cases := []struct {
		cert *x509.Certificate
		want string
		days int
	}{
		{mk("a", now.Add(-48*time.Hour), now.Add(-time.Hour), "a.test"), "истёк", -1},
		{mk("a", now.Add(time.Hour), now.Add(48*time.Hour), "a.test"), "ещё не действует", 1},
		{mk("b", now.Add(-time.Hour), now.Add(10*24*time.Hour+time.Hour), "b.test"), "выдан не для a.test", 10},
		{mk("a", now.Add(-time.Hour), now.Add(30*24*time.Hour+time.Hour), "a.test"), "самоподписанный", 30},
	}
	for _, c := range cases {
		info := certCheck(tls.ConnectionState{PeerCertificates: []*x509.Certificate{c.cert}}, "a.test")
		if !strings.Contains(info.Err, c.want) || info.Days != c.days {
			t.Errorf("err=%q days=%d; want %q, %d", info.Err, info.Days, c.want, c.days)
		}
	}
}
