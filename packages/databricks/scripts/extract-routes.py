"""CDK の API Gateway 定義から (method, path, lambda entry) を抽出して routes.json を生成する。"""
import json, re, sys, pathlib

CDK = pathlib.Path(__file__).resolve().parents[2] / "cdk" / "lib" / "construct"

def extract(file: str, api: str):
    s = (CDK / file).read_text()
    # 関数変数 -> entry
    fn = {}
    for m in re.finditer(r"const (\w+)\s*=\s*(?:new NodejsFunction\(\s*this,\s*'[^']+',\s*\{[^}]*?entry:\s*'([^']+)'|this\.createTeamAccessControlFunction\(\s*'[^']+',\s*'([^']+)')", s, re.S):
        fn[m.group(1)] = m.group(2) or m.group(3)
    # entry が別行にある NodejsFunction( this, 'X', { ... entry: ... }) の取りこぼし対策
    for m in re.finditer(r"const (\w+)\s*=\s*new NodejsFunction\(\s*this,\s*'[^']+',\s*\{.*?entry:\s*'([^']+)'", s, re.S):
        fn.setdefault(m.group(1), m.group(2))
    # リソース変数 -> パス
    res = {"api.root": ""}
    routes = []
    # チェーン: X.addResource('a').addResource('b').addMethod('GET', new LambdaIntegration(fn)
    for m in re.finditer(r"(?:const (\w+)\s*=\s*)?([\w.]+)((?:\s*\.addResource\('[^']+'\))+)(?:\s*\.addMethod\(\s*'(\w+)',\s*new LambdaIntegration\((\w+)[,)])?", s):
        var, base, chain, method, f = m.groups()
        if base not in res:
            continue
        path = res[base] + "".join("/" + p for p in re.findall(r"addResource\('([^']+)'\)", chain))
        if var:
            res[var] = path
        if method:
            routes.append((method, path, f))
    for m in re.finditer(r"(\w+)\.addMethod\(\s*'(\w+)',\s*new LambdaIntegration\((\w+)[,)]", s):
        if m.group(1) in res:
            routes.append((m.group(2), res[m.group(1)], m.group(3)))
    out = []
    for method, path, f in routes:
        if f not in fn:
            print(f"WARN: {api} {method} {path}: function {f} not found", file=sys.stderr)
            continue
        out.append({"api": api, "method": method, "path": path or "/", "entry": fn[f].replace("./lambda/", "").replace(".ts", "")})
    return out

routes = extract("api.ts", "main") + extract("team-access-control.ts", "tac")
json.dump(routes, sys.stdout, ensure_ascii=False, indent=1)
