"""HWP(5.x)·HWPX 문서에서 문단 텍스트를 뽑는다. 외부 프로그램·라이브러리 없이 표준 라이브러리만 사용.

- HWP 5.x: OLE 복합문서(CFB) 안의 BodyText/SectionN 스트림(zlib raw deflate)을 읽고
  HWPTAG_PARA_TEXT(67) 레코드의 UTF-16LE 텍스트를 문단 단위로 꺼낸다.
  표 안의 글도 셀 순서(행 우선)대로 나오므로 pdftotext -raw 와 비슷한 순서가 된다.
- HWPX: ZIP 안의 Contents/sectionN.xml 에서 <hp:p> 문단의 <hp:t> 텍스트를 모은다.
사용: python tools/hwp_text.py 파일.hwp > 출력.txt
"""
import re, struct, sys, zlib, zipfile
import xml.etree.ElementTree as ET


# ---------------- OLE 복합문서(CFB) 최소 구현 ----------------
class CFB:
    def __init__(self, data):
        if data[:8] != b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":
            raise ValueError("OLE 복합문서가 아닙니다")
        self.d = data
        self.ss = 1 << struct.unpack_from("<H", data, 30)[0]      # sector size
        self.mss = 1 << struct.unpack_from("<H", data, 32)[0]     # mini sector size
        n_fat, dir_start = struct.unpack_from("<I", data, 44)[0], struct.unpack_from("<I", data, 48)[0]
        self.mini_cutoff = struct.unpack_from("<I", data, 56)[0]
        minifat_start, n_minifat = struct.unpack_from("<II", data, 60)
        difat_start, n_difat = struct.unpack_from("<II", data, 68)
        difat = list(struct.unpack_from("<109I", data, 76))
        s = difat_start
        for _ in range(n_difat):
            sec = self._sector(s)
            vals = struct.unpack("<%dI" % (self.ss // 4), sec)
            difat += vals[:-1]; s = vals[-1]
        self.fat = []
        for s in difat[:n_fat]:
            self.fat += struct.unpack("<%dI" % (self.ss // 4), self._sector(s))
        self.entries = []
        dirdata = self._chain(dir_start)
        for i in range(0, len(dirdata), 128):
            e = dirdata[i:i + 128]
            nlen = struct.unpack_from("<H", e, 64)[0]
            name = e[:max(0, nlen - 2)].decode("utf-16le", "replace")
            typ = e[66]
            left, right, child = struct.unpack_from("<III", e, 68)
            start, size = struct.unpack_from("<IQ", e, 116)
            self.entries.append({"name": name, "type": typ, "left": left, "right": right, "child": child, "start": start, "size": size & 0xFFFFFFFF})
        root = self.entries[0]
        self.ministream = self._chain(root["start"])[: root["size"]] if root["start"] < 0xFFFFFFF0 else b""
        self.minifat = []
        if n_minifat:
            mf = self._chain(minifat_start)
            self.minifat = list(struct.unpack("<%dI" % (len(mf) // 4), mf))

    def _sector(self, n):
        off = (n + 1) * self.ss
        return self.d[off: off + self.ss]

    def _chain(self, start):
        out, s, guard = [], start, 0
        while s < 0xFFFFFFF0 and guard < 1_000_000:
            out.append(self._sector(s)); s = self.fat[s]; guard += 1
        return b"".join(out)

    def _minichain(self, start):
        out, s, guard = [], start, 0
        while s < 0xFFFFFFF0 and guard < 1_000_000:
            out.append(self.ministream[s * self.mss:(s + 1) * self.mss]); s = self.minifat[s]; guard += 1
        return b"".join(out)

    def _children(self, idx):
        res, stack = [], [self.entries[idx]["child"]]
        while stack:
            i = stack.pop()
            if i >= len(self.entries) or i == 0xFFFFFFFF: continue
            e = self.entries[i]
            res.append(i); stack += [e["left"], e["right"]]
        return res

    def open(self, path):
        idx = 0
        for part in path.split("/"):
            idx = next((i for i in self._children(idx) if self.entries[i]["name"] == part), None)
            if idx is None: raise KeyError(path)
        e = self.entries[idx]
        data = self._minichain(e["start"]) if e["size"] < self.mini_cutoff else self._chain(e["start"])
        return data[: e["size"]]

    def listdir(self, path):
        idx = 0
        for part in path.split("/"):
            idx = next(i for i in self._children(idx) if self.entries[i]["name"] == part)
        return [self.entries[i]["name"] for i in self._children(idx)]


# ---------------- HWP 5.x 본문 ----------------
HWPTAG_PARA_TEXT = 67
# 제어문자 중 뒤에 7개 WCHAR(14바이트)가 붙는 확장/인라인 컨트롤
EXT_CTRL = {1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23}


def para_text(buf):
    out, i, n = [], 0, len(buf) // 2
    while i < n:
        ch = struct.unpack_from("<H", buf, i * 2)[0]
        if ch < 32:
            if ch in (9,):            # 탭
                out.append("\t"); i += 8; continue
            if ch in (10, 13): out.append("\n"); i += 1; continue
            if ch in EXT_CTRL: i += 8; continue
            i += 1; continue
        out.append(chr(ch)); i += 1
    # UTF-16 서로게이트 쌍을 실제 문자로 합친다
    return "".join(out).encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace")


def hwp_text(path):
    cfb = CFB(open(path, "rb").read())
    header = cfb.open("FileHeader")
    flags = struct.unpack_from("<I", header, 36)[0]
    compressed, encrypted = bool(flags & 1), bool(flags & 2)
    if encrypted: raise ValueError("암호화된 HWP")
    sections = sorted((n for n in cfb.listdir("BodyText") if n.startswith("Section")), key=lambda s: int(s[7:]))
    paras = []
    for sec in sections:
        data = cfb.open("BodyText/" + sec)
        if compressed: data = zlib.decompress(data, -15)
        p = 0
        while p + 4 <= len(data):
            hdr = struct.unpack_from("<I", data, p)[0]; p += 4
            tag, size = hdr & 0x3FF, (hdr >> 20) & 0xFFF
            if size == 0xFFF: size = struct.unpack_from("<I", data, p)[0]; p += 4
            if tag == HWPTAG_PARA_TEXT:
                paras.append(para_text(data[p:p + size]))
            p += size
    return "\n".join(t.rstrip("\n") for t in paras)


# ---------------- HWPX ----------------
def hwpx_text(path):
    z = zipfile.ZipFile(path)
    names = sorted((n for n in z.namelist() if re.match(r"Contents/section\d+\.xml$", n)), key=lambda s: int(re.findall(r"\d+", s)[-1]))
    paras = []
    for n in names:
        root = ET.fromstring(z.read(n))
        for el in root.iter():
            if el.tag.endswith("}p"):
                # 이 문단에 직접 속한 run 의 텍스트만 (하위 표 문단은 따로 순회됨)
                txt = []
                for run in el:
                    if run.tag.endswith("}run"):
                        for t in run:
                            if t.tag.endswith("}t") and t.text: txt.append(t.text)
                            if t.tag.endswith("}t"):
                                for sub in t:
                                    if sub.tail: txt.append(sub.tail)
                paras.append("".join(txt))
    return "\n".join(paras)


def extract(path):
    return hwpx_text(path) if path.lower().endswith(".hwpx") else hwp_text(path)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    print(extract(sys.argv[1]))
