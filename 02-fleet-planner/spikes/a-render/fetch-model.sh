#!/usr/bin/env bash
# Fetch the skinned-people stand-in: three.js r187's RobotExpressive.glb (CC0, Tomás Laulhé, modified by Don McCurdy).
# Only needed for ?peopleMode=skinned.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p public/models
curl -fsSL -o public/models/RobotExpressive.glb \
  https://raw.githubusercontent.com/mrdoob/three.js/r187/examples/models/gltf/RobotExpressive/RobotExpressive.glb
ls -l public/models/RobotExpressive.glb
