#!/usr/bin/env bash

SKIP_BACKEND=0
NO_REBUILD_BACKEND=0
NO_DELETE_BACKEND=0
PLUGIN_NAME=$(jq -r .pluginname .vscode/settings.json)
PLUGIN_DIR=$(echo $PWD)

while [[ $# -gt 0 ]]; do
    case $1 in
        --no-rebuild-backend)
            NO_REBUILD_BACKEND=1
            shift
            ;;
        --skip-backend)
            SKIP_BACKEND=1
            shift
            ;;
        --no-delete-backend)
            NO_DELETE_BACKEND=1
            shift
            ;;
        *)
            shift
            ;;
    esac
done

if [[ $NO_REBUILD_BACKEND == 0 && $SKIP_BACKEND == 0 ]]; then
    cd backend;
    make;
    if [[ $? != 0 ]]; then
        echo "Could not build backend. Exiting.";
        exit 1;
    fi
fi

cd $PLUGIN_DIR
rm -rf ./dist/
pnpm run build_norm

if [[ $? != 0 ]]; then
    echo "Could not build frontend. Exiting.";
    exit 1;
fi

shopt -s nullglob
rm -rf ./out
mkdir -p ./out/tmp
cp -r ./{main.py,plugin.json,package.json,dist,LICENSE,README.md} ./out/tmp/
cp -r ./defaults/* out/tmp/
if [[ $SKIP_BACKEND == 0 ]]; then
    mkdir -p ./out/tmp/bin
    cp -r ./backend/out/* ./out/tmp/bin/
fi

(
  cd ./out/tmp || exit
  zip -r "../$PLUGIN_NAME.zip" .
)

rm -rf ./out/tmp