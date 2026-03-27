class AdManager {
    constructor() {
        this.vastSources = [
            { url: '你的VAST1', weight: 5 },
            { url: '你的VAST2', weight: 3 }
        ];

        this.popAd = "https://prime-president.com/dAmeF.zsdBG/NRvsZsG/UW/xehm/9iu/ZaUZlik_P/TLYc5AMPDKQn4dNuD/U/t/NCjCkxw/NiDag-0SOeSAZWsPajWc1epddzDt0zxt";
    }

    getWeightedAd() {
        let total = this.vastSources.reduce((sum, i) => sum + i.weight, 0);
        let rand = Math.random() * total;

        for (let item of this.vastSources) {
            if (rand < item.weight) return item.url;
            rand -= item.weight;
        }
    }

    async parseVast(url) {
        try {
            const res = await fetch(url);
            const text = await res.text();
            const match = text.match(/<MediaFile.*?><!\[CDATA\[(.*?)\]\]><\/MediaFile>/);
            return match ? match[1] : null;
        } catch {
            return null;
        }
    }

    async getAd() {
        for (let i = 0; i < this.vastSources.length; i++) {
            let url = this.getWeightedAd();
            let ad = await this.parseVast(url);
            if (ad) return ad;
        }
        return null;
    }

    showPop() {
        let s = document.createElement('script');
        s.src = this.popAd;
        document.body.appendChild(s);
    }
}

window.AdManager = AdManager;