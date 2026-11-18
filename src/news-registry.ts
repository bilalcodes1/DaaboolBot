/** Curated publisher registry. A listed publisher is not automatically permission to fetch or reuse media. */
export interface NewsPublisher {id:string;name:string;host:string;category:string;feedUrl?:string;enabled:boolean;access:string}
const entries: Array<[string,string,string,string,string?]> = [
 ['aljazeera-tech','Al Jazeera Technology','www.aljazeera.net','تكنولوجيا'],
 ['ars','Ars Technica','arstechnica.com','تكنولوجيا','https://arstechnica.com/feed/'],
 ['verge','The Verge','www.theverge.com','تكنولوجيا'],['techcrunch','TechCrunch','techcrunch.com','تكنولوجيا'],
 ['mit-review','MIT Technology Review','www.technologyreview.com','تكنولوجيا'],['ieee','IEEE Spectrum','spectrum.ieee.org','تكنولوجيا'],
 ['bleeping','BleepingComputer','www.bleepingcomputer.com','أمن رقمي','https://www.bleepingcomputer.com/feed/'],
 ['krebs','KrebsOnSecurity','krebsonsecurity.com','أمن رقمي'],['record','The Record','therecord.media','أمن رقمي'],
 ['darkreading','Dark Reading','www.darkreading.com','أمن رقمي'],['wired','Wired Security','www.wired.com','أمن رقمي'],
 ['sciencedaily','ScienceDaily','www.sciencedaily.com','علوم','https://www.sciencedaily.com/rss/top/science.xml'],
 ['nature','Nature','www.nature.com','علوم'],['science','Science','www.science.org','علوم'],['newscientist','New Scientist','www.newscientist.com','علوم'],
 ['medicalxpress','Medical Xpress','medicalxpress.com','صحة'],['nih','NIH','www.nih.gov','صحة'],
 ['nasa','NASA','www.nasa.gov','فضاء','https://www.nasa.gov/feed/'],['esa','ESA','www.esa.int','فضاء'],['noaa','NOAA','www.noaa.gov','طبيعة'],
 ['nationalgeographic','National Geographic','www.nationalgeographic.com','طبيعة'],['smithsonian','Smithsonian Magazine','www.smithsonianmag.com','علوم'],
 ['electrek','Electrek','electrek.co','نقل','https://electrek.co/feed/'],['insideevs','InsideEVs','insideevs.com','نقل'],
 ['ieee-robotics','IEEE Spectrum Robotics','spectrum.ieee.org','روبوتات'],['dronedj','DroneDJ','dronedj.com','نقل'],['dronelife','DRONELIFE','dronelife.com','نقل'],
 ['newatlas','New Atlas','newatlas.com','ابتكارات','https://newatlas.com/index.rss'],['engineering','Interesting Engineering','interestingengineering.com','ابتكارات'],
 ['ign','IGN','www.ign.com','ألعاب'],['gamespot','GameSpot','www.gamespot.com','ألعاب','https://www.gamespot.com/feeds/mashup/'],['eurogamer','Eurogamer','www.eurogamer.net','ألعاب'],
 ['gsmarena','GSMArena','www.gsmarena.com','أجهزة'],['android','Android Authority','www.androidauthority.com','أجهزة','https://www.androidauthority.com/feed/'],
 ['macrumors','MacRumors','www.macrumors.com','أجهزة','https://www.macrumors.com/macrumors.xml'],['9to5mac','9to5Mac','9to5mac.com','أجهزة'],['notebookcheck','Notebookcheck','www.notebookcheck.net','أجهزة'],
 ['mit','MIT News','news.mit.edu','علوم','https://news.mit.edu/rss/research'],
];
export const NEWS_PUBLISHERS:readonly NewsPublisher[]=entries.map(([id,name,host,category,feedUrl])=>({id,name,host,category,...(feedUrl?{feedUrl}:{}),enabled:!!feedUrl&&id!=='macrumors',access:id==='macrumors'?'disabled_cross_host_feed_redirect':feedUrl?'public_feed_article_verification_required':'disabled_pending_feed_and_access_verification'}));
export const publisherFor=(url:string):NewsPublisher|undefined=>{try{return NEWS_PUBLISHERS.find(p=>p.host===new URL(url).hostname);}catch{return undefined;}};
