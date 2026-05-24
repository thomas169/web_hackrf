# webusb_sdr
Browser frontend for SDR's.

![web_hackrf_ui](web_hackrf.png)

HackRF and RTL-SDR, others one day perhaps.

As it uses WebUSB likely only Chrome supports it. It will not work on Firefox for example.

Inspired by URH's waterfall and FFT always crashing or just generally going slow.

## Build

Run from repo root:

    npm install
    npm run build
    npm run serve

And open to `http://localhost:8000/docs/web_sdr.html` in a WebUSB supported browser.