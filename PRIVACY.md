# Политика конфиденциальности / Privacy Policy

_Действует с 19 октября 2026 года. Расширение «SoundCloud Downloader»._

## Кратко

Расширение не собирает, не хранит у себя на серверах и не передаёт третьим лицам никакие данные пользователя. Серверов у расширения нет. Всё работает внутри вашего браузера.

## Что расширение делает с данными

| Данные | Зачем | Куда уходят |
|---|---|---|
| Cookie `oauth_token` сайта soundcloud.com (разрешение `cookies`) | Если вы вошли на SoundCloud, расширение запрашивает API SoundCloud от вашего имени. Так доступны оригинальные файлы и полные версии треков. | Только в `api-v2.soundcloud.com`, в заголовке `Authorization`. Расширение не сохраняет cookie и никуда больше её не отправляет. |
| Данные страниц soundcloud.com: треки, плейлисты, ссылки на потоки (скрипт на страницах SoundCloud) | Определить, что скачивать, и получить поток из плеера сайта. | Остаются в браузере. |
| Настройки расширения, временный кэш `client_id` (`storage`) | Помнить ваши настройки. | Хранятся локально, в `chrome.storage.local`. |
| Скачанные файлы (`downloads`) | Сохранить музыку в папку «Загрузки». | Ваш компьютер. |

Сетевые запросы расширение отправляет только на домены SoundCloud: `soundcloud.com`, `api-v2.soundcloud.com`, `*.sndcdn.com`, `*.soundcloud.cloud`. Аналитики, рекламы, трекеров и удалённого кода нет.

## Контакты

Вопросы задавайте через issues репозитория: https://github.com/KROU4/soundcloud-downloader/issues

---

## English

SoundCloud Downloader does not collect, store or share any user data and has no servers of its own.

- **Cookies.** If you are signed in to soundcloud.com, the `oauth_token` cookie is read and sent only to `api-v2.soundcloud.com`, so that the extension can fetch full tracks and original files on your behalf. It is never stored or sent elsewhere.
- **Page data.** Data from soundcloud.com pages (track lists, stream links from the site's player) stays in your browser.
- **Settings.** Settings and a cached SoundCloud `client_id` are kept in `chrome.storage.local`.
- **Network.** Network requests go only to SoundCloud domains (`soundcloud.com`, `api-v2.soundcloud.com`, `*.sndcdn.com`, `*.soundcloud.cloud`).
- **Nothing else.** There is no analytics, no advertising, no tracking and no remote code.

Contact: https://github.com/KROU4/soundcloud-downloader/issues
