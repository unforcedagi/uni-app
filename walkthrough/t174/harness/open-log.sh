#!/usr/bin/env bash
# T-174: what xdg-open launched, for which file (name, type, hash); then the real viewer for a few seconds.
viewer=$1; file=$2
echo "{\"viewer\":\"$viewer\",\"file\":\"$file\",\"mime\":\"$(file -b --mime-type "$file")\",\"sha256\":\"$(sha256sum "$file" | cut -d' ' -f1)\"}" >> "$UNI_T76_DIR/opened.log"
exec timeout "${VIEW_SECS:-5}" "$viewer" "$file"
