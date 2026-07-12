#!/usr/bin/env python3
"""Patch SV_NextDownload_f for working UDP pak downloads.

Stock clients save non-official pak downloads under downloads/ and use that
name in the transfer, but the stock server compares (and echoes) its own
gamedir-relative name, so every UDP pak transfer dies with "nextdl message for
wrong filename". Production 2.1 servers never hit this because pak downloads
went over HTTP — but the only HTTP source clients accept for pure content is
the official update mirror, which is long dead.

Run from the qfusion source/ directory. Exits non-zero (failing the image
build) if the anchors are not found exactly once.
"""
import sys

PATH = "server/sv_client.c"
src = open(PATH).read()

old_cmp = (
    "\tif( Q_stricmp( client->download.name, Cmd_Argv( 1 ) ) )\n"
    "\t{\n"
    "\t\tCom_Printf( \"nextdl message for wrong filename, from: %s\\n\", client->name );\n"
    "\t\treturn;\n"
    "\t}\n"
)
new_cmp = (
    "\t// racesow-docker: stock clients save non-official pak downloads under\n"
    "\t// downloads/ and request chunks under that name; accept it (and echo it\n"
    "\t// back below) so pak transfers over the game channel work.\n"
    "\tif( Q_stricmp( client->download.name, Cmd_Argv( 1 ) ) &&\n"
    "\t\t( Q_strnicmp( Cmd_Argv( 1 ), \"downloads/\", 10 ) ||\n"
    "\t\t  Q_stricmp( client->download.name, Cmd_Argv( 1 ) + 10 ) ) )\n"
    "\t{\n"
    "\t\tCom_Printf( \"nextdl message for wrong filename \\\"%s\\\", from: %s\\n\", Cmd_Argv( 1 ), client->name );\n"
    "\t\treturn;\n"
    "\t}\n"
)
if src.count(old_cmp) != 1:
    sys.exit("FATAL: nextdl compare anchor not found exactly once in " + PATH)
src = src.replace(old_cmp, new_cmp)

old_w = "\tMSG_WriteString( &tmpMessage, client->download.name );\n"
new_w = "\tMSG_WriteString( &tmpMessage, Cmd_Argv( 1 ) ); // racesow-docker: echo the client-requested name\n"
if src.count(old_w) != 1:
    sys.exit("FATAL: svc_download write anchor not found exactly once in " + PATH)
src = src.replace(old_w, new_w)

open(PATH, "w").write(src)
print("engine download patch applied to", PATH)
