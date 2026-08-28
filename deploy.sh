#!/bin/sh
# Copies the app into public/, which Caddy mounts. No build step -- plain
# static files and ES modules.
#
# public/ must never be deleted outright (`rm -rf public`): the bind mount holds
# the inode from when the container started, so removing the directory leaves
# the proxy staring at nothing and serving 404 until it is restarted. Clear the
# contents instead.
set -e
cd "$(dirname "$0")"
mkdir -p public
find public -mindepth 1 -delete
cp index.html styles.css public/
cp -r js public/
echo "public/: $(find public -type f | wc -l) files"
