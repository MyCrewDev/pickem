#!/bin/bash
# Publishes ~/Projects/pickem/docs to GitHub Pages (MyCrewDev/pickem).
set -e
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:/Users/bot-home/.nvm/versions/node/v22.22.0/bin"
cd ~/Projects/pickem

mkdir -p docs
cp site/index.html docs/index.html
# stop Jekyll from touching the static file
touch docs/.nojekyll
[ -f .gitignore ] || printf "node_modules\n.DS_Store\n" > .gitignore

git init -q
git add -A
git -c user.email="rob@bruv.co.uk" -c user.name="MyCrewDev" commit -q -m "Pick'em: PSG v Arsenal CL final bet collector" || true
git branch -M main

if gh repo view MyCrewDev/pickem >/dev/null 2>&1; then
  git remote add origin https://github.com/MyCrewDev/pickem.git 2>/dev/null || true
  git push -u origin main --force
else
  gh repo create MyCrewDev/pickem --public --source=. --remote=origin --push
fi

# enable Pages from /docs (POST to create, PUT to update if it already exists)
gh api -X POST "repos/MyCrewDev/pickem/pages" -f "source[branch]=main" -f "source[path]=/docs" >/dev/null 2>&1 \
  || gh api -X PUT "repos/MyCrewDev/pickem/pages" -f "source[branch]=main" -f "source[path]=/docs" >/dev/null 2>&1 \
  || true

echo "DONE https://mycrewdev.github.io/pickem/"
