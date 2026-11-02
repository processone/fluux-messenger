/* FLM-366: existing-pairing-only usbmuxd/lockdown opener.
 * No libimobiledevice convenience handshake, key files, logging or discovery CLI.
 * All remote input, including TLS read-ahead, spends prepaid input credit.
 * Parent owns hard per-operation deadlines and reaping; alarm bounds idle life.
 */
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <openssl/pem.h>
#include <openssl/ssl.h>
#include <plist/plist.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

#define CAP (5U * 1024U * 1024U)
#define META 65536U
#define START_CREDIT (256U * 1024U)
#define BLOCK 65536U

struct accounting { uint32_t credit, input, output; };
struct channel { int fd; SSL *tls; struct accounting *a; };
static BIO_METHOD *bio_method;
static int control;

static int exact(int fd, void *data, size_t n, int writing) {
    unsigned char *p = data;
    while (n) {
        ssize_t k = writing ? send(fd, p, n, 0) : recv(fd, p, n, 0);
        if (k < 0 && errno == EINTR) continue;
        if (k <= 0) return 0;
        p += k; n -= (size_t)k;
    }
    return 1;
}
static uint32_t be32(const unsigned char *p) {
    uint32_t v; memcpy(&v, p, 4); return ntohl(v);
}
static void put32(unsigned char *p, uint32_t v) {
    v = htonl(v); memcpy(p, &v, 4);
}
static uint32_t le32(const unsigned char *p) {
    return (uint32_t)p[0] | (uint32_t)p[1]<<8 | (uint32_t)p[2]<<16 | (uint32_t)p[3]<<24;
}
static void little(unsigned char *p, uint32_t v) {
    for (int i=0; i<4; i++) p[i] = (unsigned char)(v >> (8*i));
}
static int raw_read(struct channel *c, char *p, int n) {
    if (!c->a->credit) { errno=ENOBUFS; return -1; }
    if ((uint32_t)n > c->a->credit) n = (int)c->a->credit;
    ssize_t k;
    do { k = recv(c->fd, p, (size_t)n, 0); } while (k < 0 && errno == EINTR);
    if (k > 0) { c->a->credit -= (uint32_t)k; c->a->input += (uint32_t)k; }
    return (int)k;
}
static int raw_write(struct channel *c, const char *p, int n) {
    if ((uint32_t)n > CAP - c->a->output) { errno=ENOBUFS; return -1; }
    ssize_t k;
    do { k = send(c->fd, p, (size_t)n, 0); } while (k < 0 && errno == EINTR);
    if (k > 0) c->a->output += (uint32_t)k;
    return (int)k;
}
static int bio_read(BIO *b, char *p, int n) {
    BIO_clear_retry_flags(b);
    int k=raw_read(BIO_get_data(b),p,n);
    if (k<0 && (errno==EAGAIN || errno==EWOULDBLOCK)) BIO_set_retry_read(b);
    return k;
}
static int bio_write(BIO *b, const char *p, int n) {
    BIO_clear_retry_flags(b);
    int k=raw_write(BIO_get_data(b),p,n);
    if (k<0 && (errno==EAGAIN || errno==EWOULDBLOCK)) BIO_set_retry_write(b);
    return k;
}
static long bio_ctrl(BIO *b, int cmd, long arg, void *ptr) {
    (void)b; (void)arg; (void)ptr; return cmd == BIO_CTRL_FLUSH ? 1 : 0;
}
static int transfer(struct channel *c, void *data, uint32_t n, int writing) {
    char *p = data;
    while (n) {
        int k = c->tls ? (writing ? SSL_write(c->tls, p, (int)n) : SSL_read(c->tls, p, (int)n))
                       : (writing ? raw_write(c, p, (int)n) : raw_read(c, p, (int)n));
        if (k <= 0) return 0;
        p += k; n -= (uint32_t)k;
    }
    return 1;
}
static int64_t monotonic_ns(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC,&now)!=0) return -1;
    return (int64_t)now.tv_sec*1000000000LL+now.tv_nsec;
}
static int write_service(struct channel *c, char *data, uint32_t n, uint32_t ms) {
    int64_t now=monotonic_ns();
    if (now<0) return 0;
    int64_t deadline=now+(int64_t)ms*1000000;
    while (n) {
        now=monotonic_ns();
        if (now<0 || now>=deadline) return 0;
        int k=c->tls ? SSL_write(c->tls,data,(int)n) : raw_write(c,data,(int)n);
        if (k>0) { data+=k; n-=(uint32_t)k; continue; }
        short ready_for=POLLOUT;
        if (c->tls) {
            int error=SSL_get_error(c->tls,k);
            if (error==SSL_ERROR_WANT_READ) ready_for=POLLIN;
            else if (error!=SSL_ERROR_WANT_WRITE) return 0;
        } else if (k>=0 || (errno!=EAGAIN && errno!=EWOULDBLOCK)) return 0;
        now=monotonic_ns();
        if (now<0 || now>=deadline) return 0;
        struct pollfd ready={c->fd,ready_for,0};
        int wait_ms=(int)((deadline-now+999999)/1000000);
        int available=poll(&ready,1,wait_ms);
        if (available<0 && errno==EINTR) continue;
        if (available<=0 || !(ready.revents & ready_for)) return 0;
        /* WANT_WRITE/WANT_READ must retry the same SSL_write buffer/length.
         * Advance only on a positive result; plain partial sends work likewise. */
    }
    return 1;
}
static void dispose(struct channel *c) {
    SSL_free(c->tls); c->tls = NULL;
    if (c->fd >= 0) close(c->fd);
    c->fd = -1;
}
static int connect_mux(struct channel *c, const char *path) {
    struct sockaddr_un addr = {0}; addr.sun_family = AF_UNIX;
    if (strlen(path) >= sizeof(addr.sun_path)) return 0;
    memcpy(addr.sun_path, path, strlen(path)+1);
    c->fd = socket(AF_UNIX, SOCK_STREAM, 0);
    return c->fd >= 0 && connect(c->fd, (struct sockaddr *)&addr, sizeof(addr)) == 0;
}
static plist_t request(const char *kind) {
    plist_t p = plist_new_dict();
    plist_dict_set_item(p, "MessageType", plist_new_string(kind));
    plist_dict_set_item(p, "ClientVersionString", plist_new_string("fluux-inspector"));
    plist_dict_set_item(p, "ProgName", plist_new_string("fluux-inspector"));
    plist_dict_set_item(p, "kLibUSBMuxVersion", plist_new_uint(3));
    return p;
}
static plist_t mux(struct channel *c, plist_t req) {
    unsigned char h[16]; char *body = NULL; uint32_t n = 0;
    plist_t reply = NULL;
    if (plist_to_xml(req, &body, &n) != PLIST_ERR_SUCCESS || n > META) goto done;
    little(h, n+16); little(h+4, 1); little(h+8, 8); little(h+12, 1);
    if (!transfer(c,h,16,1) || !transfer(c,body,n,1) || !transfer(c,h,16,0)) goto done;
    free(body); body = NULL;
    n = le32(h);
    if (n <= 16 || n-16 > META || le32(h+4)!=1 || le32(h+8)!=8 || le32(h+12)!=1) goto done;
    n -= 16; body = malloc(n);
    if (body && transfer(c,body,n,0)) plist_from_memory(body,n,&reply,NULL);
    if (reply && plist_get_node_type(reply)!=PLIST_DICT) { plist_free(reply); reply=NULL; }
 done:
    if (body) { OPENSSL_cleanse(body,n); free(body); }
    plist_free(req); return reply;
}
static const char *string(plist_t p, const char *key) {
    plist_t v = plist_dict_get_item(p,key);
    return v && plist_get_node_type(v)==PLIST_STRING ? plist_get_string_ptr(v,NULL) : NULL;
}
static int uint_value(plist_t p, const char *key, uint64_t *v) {
    plist_t n = plist_dict_get_item(p,key);
    if (!n || plist_get_node_type(n)!=PLIST_UINT) return 0;
    plist_get_uint_val(n,v); return 1;
}
static int boolean(plist_t p, const char *key, int *value) {
    plist_t n = plist_dict_get_item(p,key); uint8_t v=0;
    if (!n || plist_get_node_type(n)!=PLIST_BOOLEAN) return 0;
    plist_get_bool_val(n,&v); *value = v!=0; return 1;
}
static plist_t single_mux(const char *path, struct accounting *a, plist_t req) {
    struct channel c = {-1,NULL,a}; plist_t reply=NULL;
    if (connect_mux(&c,path)) reply=mux(&c,req); else plist_free(req);
    dispose(&c); return reply;
}
static int tunnel(struct channel *c, const char *path, uint64_t device, uint16_t port) {
    if (!connect_mux(c,path)) return 0;
    plist_t p=request("Connect");
    plist_dict_set_item(p,"DeviceID",plist_new_uint(device));
    plist_dict_set_item(p,"PortNumber",plist_new_uint(htons(port)));
    p=mux(c,p); uint64_t result=1;
    int ok=p && uint_value(p,"Number",&result) && result==0;
    plist_free(p); return ok;
}
static plist_t lockdown(struct channel *c, const char *kind, plist_t req) {
    unsigned char h[4]; char *body=NULL; uint32_t n=0; plist_t reply=NULL;
    plist_dict_set_item(req,"Request",plist_new_string(kind));
    plist_dict_set_item(req,"Label",plist_new_string("fluux-inspector"));
    if (plist_to_xml(req,&body,&n)!=PLIST_ERR_SUCCESS || n>META) goto done;
    put32(h,n);
    if (!transfer(c,h,4,1) || !transfer(c,body,n,1) || !transfer(c,h,4,0)) goto done;
    free(body); body=NULL; n=be32(h);
    if (!n || n>META) goto done;
    body=malloc(n);
    if (body && transfer(c,body,n,0)) plist_from_memory(body,n,&reply,NULL);
    if (reply && (plist_get_node_type(reply)!=PLIST_DICT || !string(reply,"Request") ||
        strcmp(string(reply,"Request"),kind) || plist_dict_get_item(reply,"Error"))) {
        plist_free(reply); reply=NULL;
    }
 done:
    if (body) { OPENSSL_cleanse(body,n); free(body); }
    plist_free(req); return reply;
}
static BIO *data_bio(plist_t pair, const char *key) {
    plist_t p=plist_dict_get_item(pair,key); uint64_t n=0;
    if (!p || plist_get_node_type(p)!=PLIST_DATA) return NULL;
    const char *v=plist_get_data_ptr(p,&n);
    return v && n && n<=META ? BIO_new_mem_buf(v,(int)n) : NULL;
}
static SSL_CTX *tls_context(plist_t pair, X509 **pinned) {
    SSL_CTX *ctx=NULL; X509 *cert=NULL; EVP_PKEY *key=NULL; BIO *b;
    b=data_bio(pair,"RootCertificate");
    if (b) cert=PEM_read_bio_X509(b,NULL,NULL,NULL);
    BIO_free(b);
    b=data_bio(pair,"RootPrivateKey");
    /* No password callback: encrypted/malformed records fail, never prompt. */
    if (b) key=PEM_read_bio_PrivateKey(b,NULL,NULL,"");
    BIO_free(b);
    b=data_bio(pair,"DeviceCertificate");
    if (b) *pinned=PEM_read_bio_X509(b,NULL,NULL,NULL);
    BIO_free(b);
    if (!cert || !key || !*pinned) goto done;
    ctx=SSL_CTX_new(TLS_client_method());
    if (!ctx) goto done;
    if (!SSL_CTX_set_min_proto_version(ctx,TLS1_2_VERSION) ||
        !SSL_CTX_use_certificate(ctx,cert) || !SSL_CTX_use_PrivateKey(ctx,key) ||
        !SSL_CTX_check_private_key(ctx)) { SSL_CTX_free(ctx); ctx=NULL; }
 done:
    X509_free(cert); EVP_PKEY_free(key); return ctx;
}
static int enable_tls(struct channel *c, SSL_CTX *ctx, X509 *pinned) {
    SSL *tls=SSL_new(ctx); if (!tls) return 0;
    BIO *b=BIO_new(bio_method);
    if (!b) { SSL_free(tls); return 0; }
    BIO_set_data(b,c); BIO_set_init(b,1); SSL_set_bio(tls,b,b);
    /* Exact existing-pair certificate pin; no public CA or hostname fallback.
     * Publish TLS only after pinning, including for StopSession on failure. */
    SSL_set_verify(tls,SSL_VERIFY_NONE,NULL);
    int ok=SSL_connect(tls)==1;
    X509 *peer=ok ? SSL_get1_peer_certificate(tls) : NULL;
    ok=peer && X509_cmp(peer,pinned)==0;
    X509_free(peer);
    if (ok) c->tls=tls; else SSL_free(tls);
    return ok;
}
static int reply(char status, uint32_t n, struct accounting *a, void *data) {
    unsigned char h[9]; h[0]=(unsigned char)status; put32(h+1,n); put32(h+5,a->input);
    return exact(control,h,9,1) && (!data || exact(control,data,n,1));
}
int main(int argc, char **argv) {
    struct rlimit no_core={0,0}; if (setrlimit(RLIMIT_CORE,&no_core)!=0) return 1;
    signal(SIGPIPE,SIG_IGN);
    if (argc!=2) return 1;
    char *end; long fd=strtol(argv[1],&end,10);
    if (*end || fd<3 || fd>INT_MAX) return 1;
    control=(int)fd;
    alarm(121);  /* Also bound a caller that stalls before delivering config. */
    unsigned char config[12]; char udid[129]={0},path[104]={0};
    if (!exact(control,config,12,0)) return 1;
    uint32_t life=be32(config), un=be32(config+4), pn=be32(config+8);
    if (!life || life>121000 || !un || un>128 || !pn || pn>=sizeof(path) ||
        !exact(control,udid,un,0) || !exact(control,path,pn,0) ||
        strlen(udid)!=un || strlen(path)!=pn || path[0]!='/') return 1;
    struct itimerval timer={0};
    timer.it_value.tv_sec=life/1000; timer.it_value.tv_usec=(life%1000)*1000;
    if (setitimer(ITIMER_REAL,&timer,NULL)!=0) return 1;
    struct accounting a={START_CREDIT,0,0};
    struct channel lock={-1,NULL,&a}, service={-1,NULL,&a};
    plist_t p=NULL, pair=NULL; SSL_CTX *ctx=NULL; X509 *pinned=NULL;
    char *session=NULL; char status='D'; uint64_t device=0; unsigned matches=0;
    bio_method=BIO_meth_new(BIO_TYPE_SOURCE_SINK,"bounded-socket");
    if (!bio_method || !BIO_meth_set_read(bio_method,bio_read) ||
        !BIO_meth_set_write(bio_method,bio_write) || !BIO_meth_set_ctrl(bio_method,bio_ctrl)) goto done;
    p=single_mux(path,&a,request("ListDevices"));
    plist_t list=p ? plist_dict_get_item(p,"DeviceList") : NULL;
    if (!list || plist_get_node_type(list)!=PLIST_ARRAY) goto done;
    for (uint32_t i=0;i<plist_array_get_size(list);i++) {
        plist_t entry=plist_array_get_item(list,i);
        if (plist_get_node_type(entry)!=PLIST_DICT) goto done;
        plist_t props=plist_dict_get_item(entry,"Properties");
        if (!props || plist_get_node_type(props)!=PLIST_DICT) goto done;
        const char *serial=string(props,"SerialNumber"), *type=string(props,"ConnectionType");
        if (serial && type && !strcmp(serial,udid) && !strcmp(type,"USB")) {
            if (!uint_value(entry,"DeviceID",&device) || !device || device>UINT32_MAX) goto done;
            matches++;
        }
    }
    if (matches!=1) goto done;
    plist_free(p); p=request("ReadPairRecord"); status='P';
    plist_dict_set_item(p,"PairRecordID",plist_new_string(udid));
    p=single_mux(path,&a,p);
    BIO *record=p ? data_bio(p,"PairRecordData") : NULL;
    if (!record) goto done;
    char *record_bytes=NULL; long record_n=BIO_get_mem_data(record,&record_bytes);
    if (record_n>0 && record_n<=META) plist_from_memory(record_bytes,(uint32_t)record_n,&pair,NULL);
    BIO_free(record);
    if (!pair || plist_get_node_type(pair)!=PLIST_DICT || !string(pair,"HostID") ||
        !strlen(string(pair,"HostID")) || strlen(string(pair,"HostID"))>128) goto done;
    ctx=tls_context(pair,&pinned); if (!ctx) goto done;
    plist_free(p); p=single_mux(path,&a,request("ReadBUID"));
    if (!p || !string(p,"BUID") || !strlen(string(p,"BUID")) || strlen(string(p,"BUID"))>128) goto done;
    plist_t req=plist_new_dict();
    plist_dict_set_item(req,"HostID",plist_new_string(string(pair,"HostID")));
    plist_dict_set_item(req,"SystemBUID",plist_new_string(string(p,"BUID")));
    plist_free(p); p=NULL; status='L';
    if (!tunnel(&lock,path,device,62078)) { plist_free(req); goto done; }
    p=lockdown(&lock,"StartSession",req); int ssl=0;
    if (!p || !string(p,"SessionID") || !strlen(string(p,"SessionID")) ||
        !boolean(p,"EnableSessionSSL",&ssl) || !ssl) goto done;
    session=strdup(string(p,"SessionID"));
    if (!session || !enable_tls(&lock,ctx,pinned)) goto done;
    plist_free(p); p=NULL; status='S';
    req=plist_new_dict();
    plist_dict_set_item(req,"Service",plist_new_string("com.apple.webinspector"));
    p=lockdown(&lock,"StartService",req); uint64_t port=0;
    if (!p || !uint_value(p,"Port",&port) || !port || port>65535 ||
        !boolean(p,"EnableServiceSSL",&ssl)) goto done;
    if (!tunnel(&service,path,device,(uint16_t)port) || (ssl && !enable_tls(&service,ctx,pinned))) goto done;
    plist_free(p); p=NULL; plist_free(pair); pair=NULL;
    /* No remote record, key or metadata is sent to the parent. */
    if (fcntl(service.fd,F_SETFL,O_NONBLOCK)!=0 || !reply('O',0,&a,NULL)) goto done;
    for (;;) {
        unsigned char h[13]; char data[BLOCK];
        if (!exact(control,h,13,0)) break;
        uint32_t n=be32(h+1), ms=be32(h+5), credit=be32(h+9);
        if (h[0]=='X') break;
        if (!n || n>BLOCK || !ms || ms>1000 || credit>CAP-a.input-a.credit) break;
        a.credit+=credit;
        if (h[0]=='W') {
            if (!exact(control,data,n,0) || !write_service(&service,data,n,ms)) break;
            if (!reply('O',n,&a,NULL)) break;
        } else if (h[0]=='R') {
            /* Nonblocking TLS keeps partial records inside SSL across no-data
             * timeouts. Parent exchange timeouts instead abort, never replay. */
            int k=service.tls ? SSL_read(service.tls,data,(int)n) : raw_read(&service,data,(int)n);
            int retry=service.tls ? (k<=0 && SSL_get_error(service.tls,k)==SSL_ERROR_WANT_READ)
                                 : (k<0 && (errno==EAGAIN || errno==EWOULDBLOCK));
            if (retry) {
                struct pollfd ready={service.fd,POLLIN,0};
                /* E1: no 1ms wait floor competing with a 1ms caller budget. */
                int available=poll(&ready,1,(int)(ms/2));
                if (available<0) break;
                if (!reply('T',0,&a,NULL)) break;
                continue;
            }
            if (k<=0 || !reply('O',(uint32_t)k,&a,data)) break;
        } else break;
    }
    status='E';
 done:
    /* Fixed status only; shutdown cannot print a peer-supplied value. */
    reply(status,0,&a,NULL);
    dispose(&service);
    if (session && lock.tls) {
        plist_t req=plist_new_dict(); plist_dict_set_item(req,"SessionID",plist_new_string(session));
        plist_t stopped=lockdown(&lock,"StopSession",req); plist_free(stopped);
    }
    free(session); dispose(&lock); plist_free(p); plist_free(pair);
    SSL_CTX_free(ctx); X509_free(pinned); BIO_meth_free(bio_method);
    close(control); return 0;
}
