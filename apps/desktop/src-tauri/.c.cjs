const fs=require("fs");let raw=fs.readFileSync("src/runtimes.rs","utf8");const crlf=raw.includes("\r\n");let s=raw.replace(/\r\n/g,"\n");
const pem=fs.readFileSync(".one.pem","utf8").replace(/\r/g,"");
const a=s.indexOf("        // a real root from the webpki bundle");const b=s.indexOf("        fs::write(dir.join(\"good.0\")");
s=s.slice(0,a)+"        // a real root, as PEM followed by a text dump like Android's files\n        let pem = format!(\"{}Certificate:\n    Data: dump\n\", ROOT_PEM);\n"+s.slice(b);
s=s.replace("        crate::runtimes::tests::build_with(certs);\n","        reqwest::Client::builder().tls_certs_only(certs).build().expect(\"client builds with the filtered roots\");\n");
s=s.replace("    #[test]\n    fn ca_dir_skips","    const ROOT_PEM: &str = \""+pem.replace(/\/g,"\\\\").replace(/"/g,'\\"').replace(/\n/g,"\n")+"\";\n\n    #[test]\n    fn ca_dir_skips");
fs.writeFileSync("src/runtimes.rs",crlf?s.replace(/\n/g,"\r\n"):s);
