// This fixture uses only its temporary data store. It never starts Buzz services.
#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#import <libproc.h>
#import <signal.h>
#import <sqlite3.h>
#import <fcntl.h>
#import <unistd.h>
#import <sys/proc.h>

@interface NSObject (StorageProbe)
- (instancetype)initWithDirectory:(NSURL *)directory;
@end
@interface WKWebsiteDataStore (StorageProbe)
- (instancetype)_initWithConfiguration:(id)configuration;
- (pid_t)_networkProcessIdentifier;
- (BOOL)_networkProcessExists;
- (void)_terminateNetworkProcess;
- (void)_sendNetworkProcessPrepareToSuspend:(void (^)(void))completion;
@end
@interface WKWebView (StorageProbe)
- (pid_t)_gpuProcessIdentifier;
@end

static WKWebViewConfiguration *configuration;
static WKWebsiteDataStore *fixtureStore;
static NSTimer *capturedTimer;
static const int networkGraceChecks = 10;
static Method timerFactory;
static IMP originalTimerFactory;

void *storage_probe_configuration(const char *path) {
    NSURL *root = [NSURL fileURLWithPath:@(path) isDirectory:YES];
    Class dataConfigurationClass = NSClassFromString(@"_WKWebsiteDataStoreConfiguration");
    if (![dataConfigurationClass instancesRespondToSelector:@selector(initWithDirectory:)]) return NULL;
    id dataConfiguration = [[dataConfigurationClass alloc] initWithDirectory:root];
    fixtureStore = [[WKWebsiteDataStore alloc] _initWithConfiguration:dataConfiguration];
    configuration = [WKWebViewConfiguration new];
    configuration.websiteDataStore = fixtureStore;
    return (__bridge void *)configuration;
}

static NSTimer *captureTimer(id receiver, SEL selector, NSTimeInterval seconds, BOOL repeats, void (^block)(NSTimer *)) {
    typedef NSTimer *(*Factory)(id, SEL, NSTimeInterval, BOOL, void (^)(NSTimer *));
    NSTimer *timer = ((Factory)originalTimerFactory)(receiver, selector, seconds, repeats, block);
    if ([NSThread isMainThread]) {
        capturedTimer = timer;
        // Drive the real callback explicitly instead of racing the run loop.
        [timer setFireDate:NSDate.distantFuture];
    }
    return timer;
}

void storage_probe_capture_begin(void) {
    timerFactory = class_getClassMethod(NSTimer.class, @selector(scheduledTimerWithTimeInterval:repeats:block:));
    originalTimerFactory = method_getImplementation(timerFactory);
    method_setImplementation(timerFactory, (IMP)captureTimer);
}

void *storage_probe_capture_end(void) {
    method_setImplementation(timerFactory, originalTimerFactory);
    return (__bridge void *)capturedTimer;
}

static BOOL spin(BOOL (^ready)(void), NSTimeInterval seconds) {
    NSDate *until = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while (!ready() && until.timeIntervalSinceNow > 0)
        [[NSRunLoop mainRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    return ready();
}

static void require(BOOL condition, NSString *label) {
    if (!condition) @throw [NSException exceptionWithName:@"StorageProbeFailure" reason:label userInfo:nil];
}

@interface Probe : NSObject <WKNavigationDelegate>
@property (nonatomic) BOOL loaded;
@property (nonatomic, strong) WKNavigation *expectedNavigation;
@end
@implementation Probe
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation {
    if (navigation == self.expectedNavigation) self.loaded = YES;
}
@end

static id evaluate(WKWebView *view, NSString *script) {
    __block BOOL done = NO;
    __block id result;
    [view evaluateJavaScript:script completionHandler:^(id value, NSError *error) {
        result = error ? error.description : value;
        done = YES;
    }];
    require(spin(^BOOL { return done; }, 10), @"JavaScript completion");
    return result ?: NSNull.null;
}

static void load(WKWebView *view, Probe *probe) {
    probe.loaded = NO;
    probe.expectedNavigation = [view loadHTMLString:@"<!doctype html><title>Isolated storage recovery fixture</title>" baseURL:[NSURL URLWithString:@"https://storage.example.org/"]];
    require(spin(^BOOL { return probe.loaded; }, 20), @"isolated page loaded");
}

static NSString *databasePath(NSURL *root) {
    NSDirectoryEnumerator *files = [[NSFileManager defaultManager] enumeratorAtURL:root includingPropertiesForKeys:nil options:0 errorHandler:nil];
    for (NSURL *file in files)
        if ([file.lastPathComponent isEqualToString:@"localstorage.sqlite3"]) return file.path;
    return nil;
}

static BOOL writerLocked(NSString *path, pid_t owner) {
    int descriptor = open([path stringByAppendingString:@"-shm"].UTF8String, O_RDONLY | O_CLOEXEC);
    if (descriptor < 0) return NO;
    // SQLite documents the WAL writer lock at byte 120 of the shared-memory file.
    // F_GETLK reads the lock without competing with WebKit for it.
    // https://sqlite.org/walformat.html#locks
    struct flock lock = {.l_start = 120, .l_len = 1, .l_type = F_RDLCK, .l_whence = SEEK_SET};
    BOOL locked = fcntl(descriptor, F_GETLK, &lock) == 0 && lock.l_type == F_WRLCK
        && (!owner || lock.l_pid == owner);
    close(descriptor);
    return locked;
}

static NSString *durableValue(NSString *path) {
    sqlite3 *database = NULL;
    sqlite3_stmt *statement = NULL;
    NSString *value = nil;
    if (sqlite3_open_v2(path.UTF8String, &database, SQLITE_OPEN_READONLY, NULL) == SQLITE_OK &&
        sqlite3_prepare_v2(database, "SELECT value FROM ItemTable WHERE key = 'draft'", -1, &statement, NULL) == SQLITE_OK &&
        sqlite3_step(statement) == SQLITE_ROW)
        value = [[NSString alloc] initWithBytes:sqlite3_column_blob(statement, 0) length:sqlite3_column_bytes(statement, 0) encoding:NSUTF16LittleEndianStringEncoding];
    sqlite3_finalize(statement);
    sqlite3_close(database);
    return value;
}

static struct proc_bsdinfo identity(pid_t pid) {
    struct proc_bsdinfo info = {0};
    proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
    return info;
}

static BOOL sameProcess(pid_t pid, struct proc_bsdinfo expected) {
    struct proc_bsdinfo now = identity(pid);
    return expected.pbi_start_tvsec && now.pbi_start_tvsec == expected.pbi_start_tvsec && now.pbi_start_tvusec == expected.pbi_start_tvusec;
}

int storage_probe_run(void *rawView, void *rawTimer, const char *path) {
    WKWebView *view = (__bridge WKWebView *)rawView;
    NSTimer *timer = (__bridge NSTimer *)rawTimer;
    WKWebsiteDataStore *store = view.configuration.websiteDataStore;
    NSURL *root = [NSURL fileURLWithPath:@(path) isDirectory:YES];
    pid_t old = 0;
    struct proc_bsdinfo oldIdentity = {0};
    int result = 1;
    @try {
        require(timer != nil, @"production watcher installed a timer");
        require(store == fixtureStore, @"Tauri uses the fixture's isolated data store");
        Probe *probe = [Probe new];
        view.navigationDelegate = probe;
        load(view, probe);
        require([evaluate(view, @"window.storageProbeDocument = true; localStorage.setItem('draft', 'durable draft'); localStorage.getItem('draft')") isEqual:@"durable draft"], @"initial save and readback");
        __block NSString *database = nil;
        require(spin(^BOOL {
            database = databasePath(root);
            return database && [durableValue(database) isEqual:@"durable draft"];
        }, 5), @"initial draft is durable");
        old = [store _networkProcessIdentifier];
        oldIdentity = identity(old);
        char binary[PROC_PIDPATHINFO_MAXSIZE] = {0};
        require(proc_pidpath(old, binary, sizeof(binary)) > 0 && strstr(binary, "/com.apple.WebKit.Networking"), @"fixture owns a Networking helper");
        pid_t gpu = [view _gpuProcessIdentifier];
        struct proc_bsdinfo gpuIdentity = identity(gpu);
        for (int i = 0; i < 3; ++i) [timer fire];
        require(sameProcess(old, oldIdentity), @"reported Networking helper remains alive");
        NSLog(@"Reported Networking PID %d; GPU PID %d; watcher received healthy observations", old, gpu);
        // This uncommitted marker also shows when WebContent reconnects to storage.
        evaluate(view, @"localStorage.setItem('pending-write', 'pending value'); true");
        require(spin(^BOOL { return writerLocked(database, old); }, 5), @"Networking helper holds a SQLite write lock");
        require(sameProcess(old, oldIdentity) && kill(old, SIGSTOP) == 0, @"stop only the fixture's helper");
        require(spin(^BOOL { return identity(old).pbi_status == SSTOP; }, 5), @"fixture's helper is suspended");
        require(writerLocked(database, old), @"suspended helper still owns the SQLite write lock");
        [store _terminateNetworkProcess];
        require(![store _networkProcessExists], @"WebKit dropped its old proxy");
        [timer fire];
        require(![store _networkProcessExists], @"watcher does not create a Networking proxy");
        __block pid_t replacement = 0;
        require(spin(^BOOL { replacement = [store _networkProcessIdentifier]; return replacement > 0 && replacement != old; }, 10), @"WebKit reports a replacement helper");
        struct proc_bsdinfo replacementIdentity = identity(replacement);
        require(sameProcess(old, oldIdentity), @"dropped helper remains alive after WebKit termination");
        require(writerLocked(database, old), @"dropped helper still holds the SQLite write lock");
        NSLog(@"WebKit dropped PID %d; replacement PID %d; old SQLite writer lock remains", old, replacement);
        // One missing callback already ran before WebKit started the replacement.
        int missingChecks = 1;
        for (; missingChecks < networkGraceChecks - 1; ++missingChecks) [timer fire];
        require(sameProcess(old, oldIdentity), @"abandoned helper survives the longer Networking grace");
        [timer fire];
        require(spin(^BOOL { return !sameProcess(old, oldIdentity); }, 5), @"production reaper stops the abandoned Networking helper after its grace");
        require(spin(^BOOL {
            return [evaluate(view, @"localStorage.getItem('pending-write') === null") isEqual:@YES];
        }, 5), @"existing page reconnects to committed storage");
        require([evaluate(view, @"window.storageProbeDocument === true") isEqual:@YES], @"recovery keeps the existing document alive");
        require([durableValue(database) isEqual:@"durable draft"], @"committed draft survives recovery");
        require([evaluate(view, @"localStorage.setItem('draft', 'recovered draft'); localStorage.getItem('draft')") isEqual:@"recovered draft"], @"recovered save reads back without reloading");
        require(spin(^BOOL { return [durableValue(database) isEqual:@"recovered draft"]; }, 5), @"recovered draft reached SQLite without reloading");
        __block BOOL flushed = NO;
        [store _sendNetworkProcessPrepareToSuspend:^{ flushed = YES; }];
        require(spin(^BOOL { return flushed; }, 10), @"recovered flush completion");
        require(!writerLocked(database, 0), @"SQLite write lock released after flush");
        require([store _networkProcessIdentifier] == replacement && sameProcess(replacement, replacementIdentity), @"reported replacement helper remains alive after the flush");
        require(!gpu || ([view _gpuProcessIdentifier] == gpu && sameProcess(gpu, gpuIdentity)), @"reported GPU helper remains alive");
        NSLog(@"PASS: abandoned helper reaped; active helpers preserved; committed draft retained; recovered write durable");
        result = 0;
    } @catch (NSException *error) {
        NSLog(@"FAIL: %@", error.reason);
    } @finally {
        [timer invalidate];
        if (sameProcess(old, oldIdentity)) {
            NSLog(@"fixture cleanup: stopping only its owned suspended helper PID %d", old);
            kill(old, SIGKILL);
            spin(^BOOL { return !sameProcess(old, oldIdentity); }, 5);
        }
        // Stop only helpers reported by this fixture's isolated store.
        if ([store _networkProcessExists]) {
            pid_t current = [store _networkProcessIdentifier];
            struct proc_bsdinfo currentIdentity = identity(current);
            [store _terminateNetworkProcess];
            if (sameProcess(current, currentIdentity)) {
                kill(current, SIGKILL);
                spin(^BOOL { return !sameProcess(current, currentIdentity); }, 5);
            }
        }
    }
    return result;
}
