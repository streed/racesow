#!/usr/bin/env bash
# Query a Warsow/qfusion server with a connectionless "getstatus" packet and
# print how many connected clients are *watchable* — i.e. real people on the
# server, excluding our own infrastructure clients (the wswtv relay and the TV
# capture spectator, whose names start with a configured prefix).
#
#   getstatus.sh host:port [excludeCsv]     (excludeCsv default: "RACESOW")
#
# NOTE: in the race gametype a spawned racer and a spectator are indistinguishable
# in getstatus (both report score -9999, team 0), so we cannot filter to only
# *racers* here — that needs in-mod knowledge. The capture director therefore
# follows "whoever is on the server" and leaves true race-only selection to a
# future in-mod director. Any failure prints 0 (treated as "nobody" -> card).
set -uo pipefail

addr="${1:?usage: getstatus.sh host:port [excludeCsv]}"
excl="${2:-RACESOW}"
host="${addr%:*}"
port="${addr##*:}"

# One perl process, select-with-timeout: no child pipeline, no signal-based
# teardown, guaranteed to exit. (The old `timeout 1 cat </dev/udp/... | tr`
# pipeline wedged prod: a UDP read never sees EOF, so every poll ended via
# timeout's signal path, and coreutils 8.28 `timeout` has a lost-SIGCHLD race
# that left it asleep forever holding the $()-pipe open. Same probe as
# capture-run.sh udp_getstatus.)
resp="$(perl -MIO::Socket::INET -MIO::Select -e '
    my ($host, $port) = @ARGV;
    my $r = "";
    my $s = IO::Socket::INET->new(Proto => "udp", PeerAddr => $host, PeerPort => $port);
    if ($s && defined $s->send("\xff\xff\xff\xffgetstatus\x0a")) {
        $s->recv($r, 65535) if IO::Select->new($s)->can_read(1.5);
    }
    $r =~ tr/\000//d;
    print $r;
' "${host}" "${port}" 2>/dev/null)"
[ -z "${resp}" ] && { echo 0; exit 0; }

# Player lines start at line 3: <score> <ping> "name" [team]. Count clients whose
# (color-stripped) name does not start with any excluded prefix.
echo "${resp}" | awk -v excl="${excl}" '
    BEGIN { n = split(excl, ex, ",") }
    NR > 2 && match($0, /"[^"]*"/) {
        name = substr($0, RSTART + 1, RLENGTH - 2)
        gsub(/\^[0-9]/, "", name)               # strip ^N color codes
        keep = 1
        for (i = 1; i <= n; i++) {
            p = ex[i]
            if (p != "" && index(name, p) == 1) { keep = 0; break }
        }
        if (keep) c++
    }
    END { print c + 0 }
'
