#!/bin/zsh -l
# Open in the user's Terminal so only the user enters the hidden BotFather token.
set -u

setup_directory="${0:A:h}/.."
if ! cd -- "$setup_directory"; then
  print -r -- 'تعذّر فتح مجلد مشروع دعبول.'
  read -r '?اضغط Enter لإغلاق النافذة… '
  exit 1
fi

/usr/bin/env node scripts/setup.mjs
setup_status=$?
print
if (( setup_status == 0 )); then
  print -r -- 'اكتمل إعداد دعبول. تستطيع الرجوع إلى Codex.'
else
  print -r -- 'توقف الإعداد. ارجع إلى Codex لمعالجة الخطوة المطلوبة ثم استئناف العمل.'
fi
read -r '?اضغط Enter لإغلاق النافذة… '
exit "$setup_status"
