#!/bin/bash

###############################################################################
# PONYOU CLI - Push Commits Script
#
# Cara penggunaan:
#   1. Buka terminal di machine dengan git & internet akses ke GitHub
#   2. Jalankan: bash PUSH-COMMITS.sh
#   3. Script akan push semua commits ke branch claude/explore-ponyou-repo-o7Q7y
#
# Commits yang akan di-push:
#   - 0a715d4: Add bundle files to gitignore
#   - abe354e: Add comprehensive CLI launcher and monitor
#   - 5a54478: Add Claude Code-like CLI system
#   - 60f8e2e: Add custom LLM provider management tools
#   - 0763c7f: Add flexible multi-provider LLM support
#   - 960545d: Implement 5 key recommendations
###############################################################################

set -e

REPO="dwiiyerr-tech/Ponyou-"
BRANCH="claude/explore-ponyou-repo-o7Q7y"
COMMIT="0a715d40ade6147f9307b5fc73e4d9d40fadab8f"

echo "🚀 PONYOU CLI - Push Commits Script"
echo "===================================="
echo ""
echo "Repository: $REPO"
echo "Branch: $BRANCH"
echo "Commit: $COMMIT"
echo ""

# Option 1: Using gh CLI (Recommended)
if command -v gh &> /dev/null; then
    echo "✅ Found 'gh' CLI - Using GitHub CLI..."
    echo ""
    gh repo fork $REPO --clone=false 2>/dev/null || true
    cd Ponyou- 2>/dev/null || cd ponyou- 2>/dev/null || true

    echo "Pushing to $BRANCH..."
    git push origin HEAD:$BRANCH

    echo ""
    echo "✅ SUCCESS! Commits pushed via GitHub CLI"
    exit 0
fi

# Option 2: Using git with HTTPS token
if [ -z "$GITHUB_TOKEN" ]; then
    echo "⚠️  GITHUB_TOKEN not set. Please set it:"
    echo "   export GITHUB_TOKEN=your_personal_access_token"
    echo ""
    echo "   To create token: https://github.com/settings/tokens"
    echo "   (scope: repo, workflow)"
    exit 1
fi

echo "✅ Found GITHUB_TOKEN - Using HTTPS with token..."
echo ""

# Configure git with token
git config --global credential.helper cache
git config --global credential.cacheDaemon.timeout 3600

# Try push
echo "Pushing to $BRANCH..."
git push -u origin HEAD:$BRANCH

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ SUCCESS! All commits pushed successfully!"
    exit 0
else
    echo ""
    echo "❌ Push failed. Trying alternative method..."

    # Alternative: Use curl to push
    if command -v curl &> /dev/null; then
        echo "Using curl to push..."
        # This requires more complex API calls, so just guide user
        echo ""
        echo "Alternative: Use GitHub Web UI"
        echo "1. Go to: https://github.com/dwiiyerr-tech/Ponyou-"
        echo "2. Click 'Sync fork' or 'Pull' button"
        echo "3. Or manually push from another machine with working git"
        exit 1
    fi
fi
