/**
 * src/i18n.js — the page's copy in Korean and English.
 *
 * The viewer used to print both languages on every line ("HWP 뷰어 / HWP Viewer"),
 * which reads as a caption rather than an interface. Now one language is shown at
 * a time: the browser's own for the first visit, and whatever the KR/EN switch
 * was last set to after that.
 */

const KEY = 'hwp-reader.lang';

export function detectLang() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'ko' || saved === 'en') return saved;
  } catch (_) { /* private mode: nothing saved, nothing lost */ }
  const list = navigator.languages && navigator.languages.length
    ? navigator.languages
    : [navigator.language || 'en'];
  return list.some((tag) => /^ko/i.test(tag)) ? 'ko' : 'en';
}

let current = detectLang();

export const getLang = () => current;

export function setLang(lang) {
  if (lang !== 'ko' && lang !== 'en') return;
  current = lang;
  try { localStorage.setItem(KEY, lang); } catch (_) { /* private mode */ }
  applyStatic();
  document.dispatchEvent(new CustomEvent('hwp:lang'));
}

export function t(key, vars) {
  const text = (STRINGS[current] && STRINGS[current][key]) ?? STRINGS.en[key] ?? key;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (_, name) => (vars[name] ?? ''));
}

const STRINGS = {
  ko: {
    title: 'HWP 뷰어',
    error_details: '오류 세부 정보',
    error_close: '오류 닫기',
    large_title: '큰 파일',
    large_body: '이 파일은 50 MB보다 큽니다. 처리하는 동안 브라우저가 느려질 수 있습니다.',
    large_proceed: '계속',
    large_cancel: '취소',
    app_title: 'HWP 뷰어',
    btn_another: '다른 파일',
    btn_json: 'JSON 내보내기',
    btn_html: 'HTML 내보내기',
    drop_primary: 'HWP 파일을 여기에 끌어다 놓으세요',
    drop_secondary: '또는 클릭해서 파일을 고르세요',
    drop_label: '파일 선택',
    drop_aria: 'HWP 파일을 여기에 끌어다 놓거나 클릭하여 선택하세요',
    file_aria: 'HWP 파일 선택',
    loading: '불러오는 중…',
    loading_aria: '불러오는 중',
    nav_tree: '문서 구조',
    nav_view: '문서 내용',
    nav_inspector: '구조 검사기',
    inspector_title: '구조 검사기',
    lang_group: '언어',
    lang_ko: '한국어로 보기',
    lang_en: '영어로 보기',

    section: '섹션 {n}',
    table: '표 {rows}×{cols}',
    empty_para: '[빈 단락]',
    go_to: '섹션 {s}, 단락 {p}로 이동',
    image: '[이미지]',

    cfb_overview: 'CFB 개요',
    row_sector_size: '섹터 크기',
    row_mini_sector: '미니 섹터 크기',
    row_mini_cutoff: '미니 스트림 임계값',
    row_total_sectors: '총 섹터 수',
    row_fat_ids: 'FAT 섹터 ID',
    row_dir_start: '디렉토리 시작 섹터',
    row_dir_entries: '총 디렉토리 항목',
    none: '(없음)',

    stream_list: '스트림 목록',
    th_name: '이름',
    th_size: '크기',
    th_start_sector: '시작 섹터',
    th_path: '경로',
    th_mini: '미니',

    record_inspector: '레코드 검사기',
    record_placeholder: '스트림 목록에서 스트림을 클릭하세요',
    stream_read_failed: '스트림 읽기 실패',
    th_tag_id: '태그 ID',
    th_level: '레벨',
    th_first_bytes: '처음 16바이트',
    record_limit: '… (최대 {n}개 표시)',
    record_error: '레코드 오류',
    no_records: '레코드 없음',

    export_title: 'HWP 내보내기',
    unexpected_error: '예상치 못한 오류가 발생했습니다.',
  },

  en: {
    title: 'HWP Viewer',
    error_details: 'Error details',
    error_close: 'Close error',
    large_title: 'Large file',
    large_body: 'This file is larger than 50 MB. The browser may slow down while processing it.',
    large_proceed: 'Proceed',
    large_cancel: 'Cancel',
    app_title: 'HWP Viewer',
    btn_another: 'Open another',
    btn_json: 'Export JSON',
    btn_html: 'Export HTML',
    drop_primary: 'Drop an HWP file here',
    drop_secondary: 'or click to choose one',
    drop_label: 'Choose file',
    drop_aria: 'Drop an HWP file here or click to select',
    file_aria: 'Select an HWP file',
    loading: 'Loading…',
    loading_aria: 'Loading',
    nav_tree: 'Document structure',
    nav_view: 'Document content',
    nav_inspector: 'Structure inspector',
    inspector_title: 'Inspector',
    lang_group: 'Language',
    lang_ko: 'Read in Korean',
    lang_en: 'Read in English',

    section: 'Section {n}',
    table: 'Table {rows}×{cols}',
    empty_para: '[empty]',
    go_to: 'Go to section {s}, paragraph {p}',
    image: '[Image]',

    cfb_overview: 'CFB Overview',
    row_sector_size: 'Sector size',
    row_mini_sector: 'Mini-sector size',
    row_mini_cutoff: 'Mini-stream cutoff',
    row_total_sectors: 'Total sectors',
    row_fat_ids: 'FAT sector IDs',
    row_dir_start: 'Directory start sector',
    row_dir_entries: 'Total directory entries',
    none: '(none)',

    stream_list: 'Stream List',
    th_name: 'Name',
    th_size: 'Size',
    th_start_sector: 'Start sector',
    th_path: 'Path',
    th_mini: 'Mini',

    record_inspector: 'Record Inspector',
    record_placeholder: 'Click a stream in the list above',
    stream_read_failed: 'Failed to read stream',
    th_tag_id: 'Tag ID',
    th_level: 'Level',
    th_first_bytes: 'First 16 bytes',
    record_limit: '… (showing first {n} records)',
    record_error: 'Record error',
    no_records: 'No records',

    export_title: 'HWP Export',
    unexpected_error: 'An unexpected error occurred.',
  },
};

/** A parser error in the current language, falling back to whatever it carries. */
export function errorMessage(err) {
  if (!err) return '';
  const text = current === 'ko' ? err.messageKo : err.messageEn;
  return text || err.message || String(err);
}

/** Fill the static page: text, aria labels and the document title. */
export function applyStatic(root = document) {
  document.documentElement.lang = current;
  document.title = t('title');
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    el.setAttribute('aria-label', t(el.dataset.i18nAria));
  });
  root.querySelectorAll('[data-lang]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.lang === current));
  });
}

export function bindSwitch() {
  document.querySelectorAll('[data-lang]').forEach((button) => {
    button.addEventListener('click', () => setLang(button.dataset.lang));
  });
  applyStatic();
}
