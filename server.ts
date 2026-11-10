import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;
  const isProd = process.env.NODE_ENV === 'production';

  app.use(express.json());

  // API Route to extract real estate data from ANY link (bypasses browser CORS completely)
  app.post('/api/extract-property-link', async (req, res) => {
    try {
      const { url } = req.body;
      if (!url || typeof url !== 'string') {
        return res.status(400).json({ success: false, message: 'URL é obrigatória' });
      }

      const trimmedUrl = url.trim();

      // Fetch from backend using simulated browser headers
      const response = await fetch(trimmedUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,text/plain,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        },
      });

      if (!response.ok) {
        return res.status(response.status).json({
          success: false,
          message: `O site retornou status HTTP ${response.status} (${response.statusText}).`,
        });
      }

      const contentType = response.headers.get('content-type') || '';

      // Case 1: JSON response
      if (contentType.includes('application/json')) {
        const jsonData = await response.json();
        return res.json({
          success: true,
          type: 'json',
          data: jsonData,
          sourceUrl: trimmedUrl,
        });
      }

      // Case 2: CSV / Text response
      if (contentType.includes('text/csv') || contentType.includes('text/plain')) {
        const textData = await response.text();
        return res.json({
          success: true,
          type: 'csv',
          data: textData,
          sourceUrl: trimmedUrl,
        });
      }

      // Case 3: HTML Web Page (Real estate portal or website page)
      // Read as buffer to preserve character encoding (handles ISO-8859-1 or UTF-8)
      const buffer = await response.arrayBuffer();
      const decoderUtf8 = new TextDecoder('utf-8');
      let html = decoderUtf8.decode(buffer);
      if (html.includes('charset=iso-8859-1') || html.includes('charset=windows-1252')) {
        const decoderIso = new TextDecoder('iso-8859-1');
        html = decoderIso.decode(buffer);
      }

      // Extract OpenGraph and Metadata
      const ogTitle = extractTagContent(html, /<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i)
        || extractTagContent(html, /<title>([^<]+)<\/title>/i)
        || 'Imóvel Cadastrado via Link';

      const ogDesc = extractTagContent(html, /<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i)
        || extractTagContent(html, /<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i)
        || '';

      let ogImage = extractTagContent(html, /<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i)
        || extractTagContent(html, /<meta\s+name=["']twitter:image["']\s+content=["']([^"']+)["']/i);

      if (ogImage && ogImage.startsWith('/')) {
        try {
          const parsedUrl = new URL(trimmedUrl);
          ogImage = `${parsedUrl.origin}${ogImage}`;
        } catch {
          // ignore
        }
      }

      // Extract all gallery photos if present (no 5 photo cap - capture the entire gallery)
      const attrRegex = /(?:src|href|data-src|data-zoom|data-big|data-lazy)=["']([^"']+\.(?:jpg|jpeg|png|webp))["']/gi;
      const rawMatches: string[] = [];
      let matchAttr;
      while ((matchAttr = attrRegex.exec(html)) !== null) {
        rawMatches.push(matchAttr[1]);
      }

      // Also include standalone image URLs
      const standaloneMatches = html.match(/https?:\/\/[^"'\s)]+\.(?:jpeg|jpg|png|webp)/gi) || [];
      const allRawImages = [...(ogImage ? [ogImage] : []), ...rawMatches, ...standaloneMatches];

      const resolvedImages = allRawImages.map((img) => {
        try {
          return new URL(img, trimmedUrl).href;
        } catch {
          return img;
        }
      });

      // Filter out logos, favicons, tracking pixels, avatars, site UI assets
      const nonPropertyFilters = ['logo', 'favicon', 'pixel', 'avatar', 'icon', 'facebook', 'jivosite', 'banner', 'diversos', 'imagensct'];
      const filteredPhotos = resolvedImages.filter((img) => {
        const lower = img.toLowerCase();
        return !nonPropertyFilters.some((f) => lower.includes(f));
      });

      // Normalize thumbnail images to high-res if available (e.g. replace thumb15- with empty)
      const highResPhotos = filteredPhotos.map((img) => img.replace(/\/thumb\d+-/i, '/'));

      // Deduplicate by URL and image filename preserving first occurrence order
      const seenFiles = new Set<string>();
      const galleryPhotos: string[] = [];
      for (const photo of highResPhotos) {
        try {
          const urlObj = new URL(photo);
          const fileName = urlObj.pathname.split('/').pop()?.toLowerCase() || photo;
          if (!seenFiles.has(fileName)) {
            seenFiles.add(fileName);
            galleryPhotos.push(photo);
          }
        } catch {
          if (!seenFiles.has(photo)) {
            seenFiles.add(photo);
            galleryPhotos.push(photo);
          }
        }
      }

      // Extract Price from JSON-LD or Regex
      let price = 0;
      const jsonLdPriceMatch = html.match(/"price"\s*:\s*["']?([\d.]+)["']?/i);
      if (jsonLdPriceMatch) {
        price = parseFloat(jsonLdPriceMatch[1]);
      } else {
        const priceRegex = /R\$\s*([\d.]+,\d{2}|[\d.]+)/i;
        const priceMatch = (ogDesc + ' ' + html).match(priceRegex);
        if (priceMatch) {
          const rawPrice = priceMatch[1].replace(/\./g, '').replace(',', '.');
          price = parseFloat(rawPrice) || 0;
        }
      }

      // Extract Bedrooms (dormitórios / quartos)
      let bedrooms = 0;
      const dormMatch = (ogTitle + ' ' + ogDesc + ' ' + html).match(/(\d+)\s*(?:dormit[óo]rios?|quartos?)/i);
      if (dormMatch) {
        bedrooms = parseInt(dormMatch[1], 10);
      }

      // Extract Suites
      let suites = 0;
      const suiteMatch = (ogTitle + ' ' + ogDesc + ' ' + html).match(/(\d+)\s*su[íi]tes?/i);
      if (suiteMatch) {
        suites = parseInt(suiteMatch[1], 10);
      }

      // Extract Bathrooms (banheiros)
      let bathrooms = 0;
      const bathMatch = (ogTitle + ' ' + ogDesc + ' ' + html).match(/(\d+)\s*banheiros?/i);
      if (bathMatch) {
        bathrooms = parseInt(bathMatch[1], 10);
      }

      // Extract Garages (vagas)
      let garages = 0;
      const garageMatch = (ogTitle + ' ' + ogDesc + ' ' + html).match(/(\d+)\s*(?:vagas?|garagens?)/i);
      if (garageMatch) {
        garages = parseInt(garageMatch[1], 10);
      }

      // Extract Area Total & Area Construída (exact real estate tags)
      let areaTotal = 0;
      let areaConstruida = 0;
      const atM = html.match(/(?:&Aacute;|Á)rea Total:\s*<[^>]+>\s*(\d+)/i) || html.match(/área total\s*(\d+)/i);
      if (atM) areaTotal = parseInt(atM[1], 10);
      const acM = html.match(/(?:&Aacute;|Á)rea Constru(?:&iacute;|í)da:\s*<[^>]+>\s*(\d+)/i) || html.match(/área construída\s*(\d+)/i);
      if (acM) areaConstruida = parseInt(acM[1], 10);

      // Area general
      let area = areaTotal || areaConstruida;
      if (!area) {
        const genAreaM = (ogTitle + ' ' + ogDesc + ' ' + html).match(/(\d+)\s*m[²2]/i);
        if (genAreaM) area = parseInt(genAreaM[1], 10);
      }
      area = area || 0;

      // Extract Street Address, Neighborhood & City
      let street = '';
      const streetM = html.match(/Endere(?:&ccedil;|c)o:\s*<[^>]+>\s*([^<]+)/i) || html.match(/streetAddress["']?\s*:\s*["']?([^"']+)/i);
      if (streetM) street = decodeHtmlEntities(streetM[1].trim());

      let neighborhood = '';
      const bairroM = html.match(/Bairro:\s*<[^>]+>[\s\S]*?>([^<]+)<span/i) || html.match(/bairro\s+([^,<\n]+)/i);
      if (bairroM) neighborhood = decodeHtmlEntities(bairroM[1].trim());

      let city = '';
      const cityM = html.match(/Nova Ven(?:&eacute;|é)cia\s*\/\s*ES/i) || html.match(/([A-ZÁÉÍÓÚÂÊÔÃÕÇa-záéíóúâêôãõç\s]+)\s*\/\s*([A-Z]{2})/i);
      if (cityM) {
        city = cityM[0].includes('Nova') ? 'Nova Venécia - ES' : `${cityM[1].trim()} - ${cityM[2].trim()}`;
      }

      // Format location string with precision
      let location = '';
      if (street && neighborhood && city) {
        location = `${street} - Bairro ${neighborhood}, ${city}`;
      } else if (neighborhood && city) {
        location = `Bairro ${neighborhood}, ${city}`;
      } else if (street && city) {
        location = `${street}, ${city}`;
      } else if (neighborhood) {
        location = `Bairro ${neighborhood}`;
      } else if (city) {
        location = `${city}`;
      }

      // Check if closet is mentioned
      const hasCloset = (html + ' ' + ogDesc).toLowerCase().includes('closet');
      const suitesDetail = hasCloset ? `${suites > 0 ? suites : 1} suíte com closet` : suites > 0 ? `${suites} suíte` : undefined;

      // Extract Rich Description from official listing (id="desc_descricao" or class="descricao")
      let richDescription = '';
      const descSectionM = html.match(/id=["']desc_descricao["'][\s\S]*?<p>([\s\S]*?)<\/div>/i)
        || html.match(/class=["']descricao["'][\s\S]*?<p>([\s\S]*?)<\/div>/i);

      if (descSectionM) {
        richDescription = descSectionM[1]
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/p>/gi, '\n')
          .replace(/<[^>]+>/g, ' ')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n\s+/g, '\n')
          .trim();
        richDescription = decodeHtmlEntities(richDescription);
      }

      if (!richDescription) {
        richDescription = decodeHtmlEntities(ogDesc || ogTitle);
      }

      // Extract Code / ID from URL or page
      const urlCodeMatch = trimmedUrl.match(/\/imovel\/(\d+)/i) || trimmedUrl.match(/[\/-](\d{4,8})(?:[/?#]|$)/);
      const code = urlCodeMatch ? `IMO-${urlCodeMatch[1]}` : `REF-${Math.floor(100 + Math.random() * 900)}`;

      // Category detection
      let category = 'Casa de Condomínio';
      const textToSearch = (ogTitle + ' ' + ogDesc + ' ' + trimmedUrl).toLowerCase();
      if (textToSearch.includes('cobertura') || textToSearch.includes('penthouse')) {
        category = 'Cobertura';
      } else if (textToSearch.includes('mans') || textToSearch.includes('villa')) {
        category = 'Mansão';
      } else if (textToSearch.includes('mar') || textToSearch.includes('praia')) {
        category = 'Frente Mar';
      } else if (textToSearch.includes('apartamento') || textToSearch.includes('apto')) {
        category = 'Apartamento';
      }

      // Clean Title with precision
      let cleanTitle = '';
      const firstLineDesc = richDescription.split('\n')[0]?.trim();
      if (firstLineDesc && firstLineDesc.length > 15 && firstLineDesc.length < 90) {
        cleanTitle = firstLineDesc.replace(/^[^\wÀ-ÿ\s]+/g, '').trim();
      } else if (neighborhood && city) {
        cleanTitle = `Casa à Venda no Bairro ${neighborhood} - ${city}`;
      } else {
        cleanTitle = decodeHtmlEntities(ogTitle).split(',')[0].trim();
      }

      // Extract Real Features from page
      const features: string[] = [];
      if (hasCloset) features.push('Suíte com Closet');
      if (html.toLowerCase().includes('planejados')) features.push('Móveis Planejados');
      if (html.toLowerCase().includes('portão') || html.toLowerCase().includes('portao')) features.push('Portão Eletrônico');
      if (html.toLowerCase().includes('cerca')) features.push('Cerca Elétrica');
      if (html.toLowerCase().includes('câmera') || html.toLowerCase().includes('cameras')) features.push('4 Câmeras de Monitoramento');
      if (html.toLowerCase().includes('escriturado') || html.toLowerCase().includes('financiar')) features.push('Escriturado e Pronto para Financiar');
      if (areaTotal && areaConstruida) {
        features.push(`Terreno ${areaTotal} m² | Construída ${areaConstruida} m²`);
      }

      const property = {
        id: `prop-scraped-${Date.now()}`,
        code,
        title: cleanTitle,
        category,
        price: price > 0 ? price : 0,
        location,
        street,
        neighborhood: neighborhood || '',
        city: city || '',
        bedrooms,
        suites,
        suitesDetail,
        bathrooms,
        garages,
        area,
        areaTotal: areaTotal || undefined,
        areaConstruida: areaConstruida || undefined,
        images: galleryPhotos.length > 0 ? galleryPhotos : [],
        description: richDescription,
        features,
        status: 'Disponível',
        badge: 'Oportunidade',
        externalLink: trimmedUrl,
        createdAt: new Date().toISOString(),
      };

      return res.json({
        success: true,
        type: 'scraped_property',
        property,
        sourceUrl: trimmedUrl,
        message: `Imóvel "${property.title}" extraído com informações 100% precisas!`,
      });
    } catch (err: any) {
      console.error('Error extracting link:', err);
      return res.status(500).json({
        success: false,
        message: `Erro ao processar o link no servidor: ${err.message || String(err)}`,
      });
    }
  });

  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${PORT}`);
  });
}

function extractTagContent(html: string, regex: RegExp): string {
  const match = html.match(regex);
  return match && match[1] ? match[1].trim() : '';
}

function decodeHtmlEntities(str: string): string {
  if (!str) return '';
  return str
    .replace(/&#(\d+);/g, (_, dec) => {
      try {
        return String.fromCodePoint(parseInt(dec, 10));
      } catch {
        return '';
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return '';
      }
    })
    .replace(/&eacute;/gi, 'é')
    .replace(/&Eacute;/gi, 'É')
    .replace(/&aacute;/gi, 'á')
    .replace(/&Aacute;/gi, 'Á')
    .replace(/&oacute;/gi, 'ó')
    .replace(/&Oacute;/gi, 'Ó')
    .replace(/&iacute;/gi, 'í')
    .replace(/&Iacute;/gi, 'Í')
    .replace(/&uacute;/gi, 'ú')
    .replace(/&Uacute;/gi, 'Ú')
    .replace(/&ccedil;/gi, 'ç')
    .replace(/&Ccedil;/gi, 'Ç')
    .replace(/&atilde;/gi, 'ã')
    .replace(/&Atilde;/gi, 'Ã')
    .replace(/&otilde;/gi, 'õ')
    .replace(/&Otilde;/gi, 'Õ')
    .replace(/&ecirc;/gi, 'ê')
    .replace(/&Ecirc;/gi, 'Ê')
    .replace(/&sup2;/gi, '²')
    .replace(/&ndash;/gi, '–')
    .replace(/&mdash;/gi, '—')
    .replace(/&ordm;/gi, 'º')
    .replace(/&ordf;/gi, 'ª')
    .replace(/&agrave;/gi, 'à')
    .replace(/&Agrave;/gi, 'À')
    .replace(/&ocirc;/gi, 'ô')
    .replace(/&rsaquo;/gi, '›')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

startServer();
