# 🛡️ SafeReach — Emergency Services Finder

**Find hospitals, police stations, vets, pharmacies, clinics, and embassies anywhere in the world — instantly.**

SafeReach is a Progressive Web App (PWA) built for travellers. It uses real-time OpenStreetMap data and works offline after the first search.

---

## 📁 File Structure

```
safereach/
├── index.html      # Main app — all UI, styles, and logic
├── manifest.json   # PWA manifest (installable, shortcuts)
├── sw.js           # Service Worker (offline cache, tile cache)
└── README.md       # This file
```

---

## 🚀 How to Deploy

### Option A — GitHub Pages (Free, Recommended)

1. Create a new GitHub repository (e.g. `safereach`)
2. Upload all four files to the root of the repository
3. Go to **Settings → Pages → Source → Deploy from branch → main / root**
4. Your app will be live at `https://yourusername.github.io/safereach/`

> **Important:** GitHub Pages serves over HTTPS, which is required for:
> - Geolocation API
> - Service Worker registration
> - Share API
> - Clipboard API

### Option B — Any Static Host

Upload all four files to any host that serves HTTPS:
- **Netlify** — drag and drop the folder at netlify.com/drop
- **Vercel** — `vercel deploy`
- **Firebase Hosting** — `firebase deploy`
- **Cloudflare Pages**

### Option C — Local Testing

```bash
# Using Python
python3 -m http.server 8080

# Using Node.js
npx serve .

# Then open: http://localhost:8080
```

> **Note:** Geolocation requires HTTPS in production. On localhost it works without HTTPS.

---

## 📱 Installing as a PWA (Add to Home Screen)

### Android (Chrome)
1. Open the app URL in Chrome
2. Tap the **three-dot menu → "Add to Home Screen"**
3. Tap **"Add"** — SafeReach appears as a native-looking app icon

### iOS (Safari)
1. Open the app URL in Safari
2. Tap the **Share button → "Add to Home Screen"**
3. Tap **"Add"**

Once installed, the app opens full-screen with no browser UI, works offline, and can receive push notifications (future feature).

---

## ✨ Features

### 🗺️ Map & Search
| Feature | Description |
|---|---|
| Live map | Dark-themed map powered by OpenStreetMap + CARTO |
| 6 categories | Hospitals, Clinics, Pharmacies, Vets, Police, Embassies |
| Auto location | GPS detection with reverse geocoding |
| Radius control | 2km / 5km / 10km search radius |
| Filter | Search bar filters results and dims unmatched map pins |
| Show All | Load all service types on the map at once |

### 🆘 Emergency Tools
| Feature | Description |
|---|---|
| SOS button | Instant access to emergency numbers for your detected country |
| 47 countries | Emergency numbers for police, ambulance, fire, coast guard |
| Safety Card | Shareable card with emergency numbers + your GPS location |
| Medical ID | Blood type, allergies, medications, emergency contact — embeds in Safety Card |
| Emergency Guide | Step-by-step guides: Medical, Fire, Robbery, Earthquake, Drowning |

### 🌍 Travel Tools
| Feature | Description |
|---|---|
| Auto country detection | Detects the country you are currently in via reverse geocoding |
| Embassy finder | Finds your home country's embassy in any location |
| Trip Planner | Look up emergency numbers for any city before you travel |
| Saved trips | Save destinations for offline access |
| Emergency Phrases | Local-language phrases in 20+ languages — tap to copy |

### 📋 Personal Tools
| Feature | Description |
|---|---|
| Saved places | Star any result to save it; persists across sessions |
| Incident Report | Log incidents on-device with type, description, GPS, timestamp |
| Weather strip | Live temperature and wind speed via Open-Meteo (no API key) |
| Dark/Light mode | Theme toggle with preference saved to localStorage |
| Offline cache | All searches cached; works offline after first use |

### 🎯 Views
| View | Description |
|---|---|
| Results tab | Card list with Call, Directions, Share, and Save buttons |
| Radar tab | Compass showing all results by bearing and relative distance |
| Phrases tab | Emergency phrases in the local language |
| Saved tab | Bookmarked places with distance from current location |

---

## 🔌 APIs Used (All Free, No Keys Required)

| API | Used For |
|---|---|
| [OpenStreetMap / Overpass API](https://overpass-api.de) | Finding nearby hospitals, police, etc. |
| [Nominatim](https://nominatim.openstreetmap.org) | Reverse geocoding (detect country) + Trip Planner search |
| [CARTO Dark Matter](https://carto.com/basemaps/) | Dark map tiles |
| [Open-Meteo](https://open-meteo.com) | Live weather (temp + wind speed) |
| [Leaflet.js](https://leafletjs.com) | Interactive map rendering |

---

## 📶 Offline Support

The Service Worker (`sw.js`) caches:

| Resource | Strategy | TTL |
|---|---|---|
| `index.html` + app shell | Cache First | Indefinite |
| Map tiles | Cache First | 7 days |
| Search results (Overpass) | Network First + cache | 5 minutes |
| Weather data | Network First + cache | 5 minutes |
| Fonts + Leaflet CDN | Cache First | Indefinite |

**After your first online search**, the app works fully offline — map tiles, results, and all stored data remain accessible.

---

## 💾 Data Storage

All data is stored **on-device only** using `localStorage`. Nothing is sent to any server.

| Key | Contents |
|---|---|
| `sr_favs` | Saved places |
| `sr_cache_v1` | Cached search results per category |
| `sr_medid_v1` | Medical ID fields |
| `sr_trips_v1` | Saved Trip Planner destinations |
| `sr_reports_v1` | Incident report log |
| `sr_theme` | Dark/light theme preference |

---

## 🛠️ Development Notes

- **No build step** — pure HTML, CSS, vanilla JavaScript
- **No dependencies** beyond Leaflet (CDN) and Google Fonts (CDN)
- **Works from Android phone** — no desktop toolchain required
- All map pins, cards, overlays, and tabs are built with `createElement` + event listeners (no `innerHTML` with user data)
- All emergency number calls use `tel:` links for native dialling
- Haptic feedback (`navigator.vibrate`) on SOS call taps

---

## 🌐 Browser Support

| Browser | Support |
|---|---|
| Chrome for Android | ✅ Full (PWA installable) |
| Samsung Internet | ✅ Full (PWA installable) |
| Firefox for Android | ✅ Full |
| Safari iOS | ✅ Full (PWA installable via Add to Home Screen) |
| Chrome Desktop | ✅ Full |

---

## 📈 Roadmap (Future)

- [ ] User accounts + cloud sync (Supabase)
- [ ] Push notifications for saved-place alerts
- [ ] Route planning between multiple services
- [ ] Community-contributed location corrections
- [ ] Tourist attraction integration (Airbnb-style)
- [ ] Multi-language UI
- [ ] Dark map style switcher (satellite / street)

---

## 👤 Author

Built by **Abdullah** as a real-world travel safety tool.

> *"The gap in the market is clear — Airbnb tells you where to sleep, SafeReach tells you where to go when something goes wrong."*

---

## 📄 License

MIT — free to use, modify, and deploy.

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software to deal in the Software without restriction, including without
limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
```
